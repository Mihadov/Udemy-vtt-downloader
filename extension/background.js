console.log("[Background] Service Worker запущен. Готов к работе.");

let isDownloading = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[Background] Получено сообщение:", message);
    
    if (message.type === 'START_DOWNLOAD') {
        if (isDownloading) {
            console.warn("[Background] Игнорируем запрос: скачивание уже идет!");
            sendResponse({ status: "already_running" });
            return;
        }
        sendResponse({ status: "started" });
        startDownloadProcess(message.courseId);
    }
});

function sendProgress(text, percent = undefined) {
    console.log(`[Background Progress] ${percent !== undefined ? percent + '%' : ''} - ${text}`);
    chrome.runtime.sendMessage({ type: 'PROGRESS', text, percent }).catch(() => {
        // Ошибка нормальна, если окно popup закрыто
    });
}

function sendError(text) {
    console.error(`[Background Error] ${text}`);
    chrome.runtime.sendMessage({ type: 'ERROR', text }).catch(() => {});
    isDownloading = false;
}

function sendDone(text) {
    console.log(`[Background Done] ${text}`);
    chrome.runtime.sendMessage({ type: 'DONE', text }).catch(() => {});
    isDownloading = false;
}

// Конвертация ArrayBuffer в Base64 (работает безопасно для больших строк в Service Worker)
function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function startDownloadProcess(courseId) {
    isDownloading = true;
    console.log(`[Background] === НАЧАЛО ПРОЦЕССА СКАЧИВАНИЯ ДЛЯ КУРСА ${courseId} ===`);
    
    try {
        sendProgress("Получение структуры курса (curriculum)...", 0);
        
        // 1. Получаем список лекций курса
        const curriculumUrl = `https://www.udemy.com/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=1000&fields[lecture]=title,asset&fields[asset]=captions`;
        console.log(`[Background] Делаем запрос: ${curriculumUrl}`);
        
        const currResp = await fetch(curriculumUrl);
        console.log(`[Background] Ответ curriculum: Status ${currResp.status}`);
        
        if (!currResp.ok) {
            if (currResp.status === 403) {
                throw new Error("Доступ запрещен (HTTP 403). Убедитесь, что вы авторизованы на Udemy и купили этот курс.");
            }
            throw new Error(`Ошибка API curriculum: HTTP ${currResp.status}`);
        }
        
        const currData = await currResp.json();
        console.log(`[Background] Структура курса успешно: получено ${currData.results?.length} элементов.`);

        if (!currData.results || currData.results.length === 0) {
            throw new Error("Курс пуст или не найден. Вы точно авторизованы?");
        }

        // 2. Фильтруем лекции с субтитрами
        sendProgress("Поиск субтитров в лекциях...", 5);
        const lecturesWithCaptions = [];
        let lectureNum = 0;

        for (const item of currData.results) {
            if (item._class === 'lecture') {
                lectureNum++;
                const asset = item.asset;
                if (asset && asset.captions && asset.captions.length > 0) {
                    // Ищем английские 'en_US' или 'en', иначе берем первые доступные
                    let targetCaption = asset.captions.find(c => c.locale_id.startsWith('en')) || asset.captions[0];
                    let captionUrl = targetCaption.url;
                    
                    // Иногда URL бывает относительным или без протокола, но Udemy обычно отдает полный
                    console.log(`[Background] Лекция ${lectureNum} ("${item.title}") имеет субтитры: ${targetCaption.locale_id}`);
                    
                    lecturesWithCaptions.push({
                        num: lectureNum,
                        title: item.title,
                        captionUrl: captionUrl,
                        locale: targetCaption.locale_id
                    });
                } else {
                    console.log(`[Background] Лекция ${lectureNum} ("${item.title}") - нет субтитров.`);
                }
            }
        }

        console.log(`[Background] Итого найдено ${lecturesWithCaptions.length} лекций с VTT.`);
        if (lecturesWithCaptions.length === 0) {
            sendDone("Скачивание завершено: в этом курсе нет видео с субтитрами.");
            return;
        }

        // 3. Скачиваем каждый VTT файл
        const finalResults = [];
        let downloadedCount = 0;
        const totalCaptions = lecturesWithCaptions.length;

        for (const lec of lecturesWithCaptions) {
            const percent = Math.round(5 + (downloadedCount / totalCaptions) * 90);
            sendProgress(`Скачивание субтитров (${downloadedCount + 1}/${totalCaptions}): "${lec.title}"`, percent);
            console.log(`[Background] Загружаем VTT для лекции ${lec.num}: ${lec.captionUrl.substring(0,60)}...`);
            
            try {
                const vttResp = await fetch(lec.captionUrl);
                if (!vttResp.ok) throw new Error(`HTTP ${vttResp.status}`);
                
                const vttText = await vttResp.text();
                // Логируем первые 50 символов VTT для отладки
                console.log(`[Background] VTT скачан (Длина: ${vttText.length}). Пример содержимого:`, vttText.substring(0, 50).replace(/\n/g, '\\n'));
                
                // Очистка от таймкодов
                const cleanText = cleanVttContent(vttText);
                
                finalResults.push({
                    num: lec.num,
                    title: lec.title,
                    locale: lec.locale,
                    text: cleanText
                });
                console.log(`[Background] Лекция ${lec.num} успешно очищена и добавлена.`);
            } catch (err) {
                console.error(`[Background] Ошибка при скачивании VTT для лекции ${lec.num}:`, err);
                finalResults.push({
                    num: lec.num,
                    title: lec.title,
                    error: err.toString(),
                    url: lec.captionUrl
                });
            }
            // Искусственная задержка (300мс), чтобы не перегружать сеть
            await new Promise(r => setTimeout(r, 300));
            downloadedCount++;
        }

        // 4. Формируем JSON-файл и скачиваем
        sendProgress('Генерация и сохранение файла...', 98);
        console.log("[Background] Все файлы скачаны. Подготовка JSON...");

        const jsonString = JSON.stringify(finalResults, null, 2);
        
        // Преобразуем строку в ArrayBuffer (UTF-8) -> Base64
        console.log(`[Background] Конвертируем строку (длина: ${jsonString.length}) в Base64 Data URL...`);
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(jsonString);
        const base64Str = bufferToBase64(utf8Bytes);
        const dataUrl = 'data:application/json;base64,' + base64Str;

        console.log(`[Background] Инициация скачивания файла (размер base64: ${base64Str.length} байт)...`);
        
        chrome.downloads.download({
            url: dataUrl,
            filename: `udemy-course-${courseId}-subtitles.json`,
            saveAs: true
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("[Background] Ошибка chrome.downloads:", chrome.runtime.lastError);
                sendError("Ошибка при сохранении файла: " + chrome.runtime.lastError.message);
            } else {
                console.log(`[Background] УСПЕХ! ID загрузки: ${downloadId}`);
                sendDone("Все субтитры успешно сохранены в загрузках!");
            }
            isDownloading = false;
        });

    } catch (e) {
        console.error("[Background] === КРИТИЧЕСКАЯ ОШИБКА ===", e);
        sendError(e.message);
        isDownloading = false;
    }
}

// Утилита очистки VTT
function cleanVttContent(vttString) {
    const lines = vttString.split('\n');
    const seen = new Set();
    const textLines = [];
    
    for (const line of lines) {
        let trimmed = line.trim();
        // Игнорируем пустые, заголовок WEBVTT, номера блоков и таймкоды
        if (!trimmed || trimmed === 'WEBVTT' || trimmed.match(/^\d+$/) || trimmed.match(/[\d:]+\s*-->/)) {
            continue;
        }
        
        // Декодируем базовые HTML сущности
        trimmed = trimmed
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
            
        // Избавляемся от тегов вроде <v Name> или <i>
        const noTags = trimmed.replace(/<\/?[^>]+(>|$)/g, "");

        if (noTags && !seen.has(noTags)) {
            seen.add(noTags);
            textLines.push(noTags);
        }
    }
    return textLines.join('\n');
}
