console.log("[Popup] Скрипт запущен");

const btn = document.getElementById('download-btn');
const statusDiv = document.getElementById('status');
const progressContainer = document.querySelector('.progress-container');
const progressBar = document.getElementById('progress-bar');

// Подписываемся на сообщения от background.js (прогресс)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[Popup] Получено сообщение от background:", message);
    if (message.type === 'PROGRESS') {
        progressContainer.style.display = 'block';
        statusDiv.innerText = message.text;
        if (message.percent !== undefined) {
            progressBar.style.width = message.percent + '%';
        }
    } else if (message.type === 'ERROR') {
        statusDiv.innerText = "Ошибка: " + message.text;
        statusDiv.style.color = "red";
        btn.disabled = false;
        btn.innerText = "Попробовать снова";
    } else if (message.type === 'DONE') {
        statusDiv.innerText = message.text;
        statusDiv.style.color = "green";
        progressBar.style.width = '100%';
        btn.disabled = false;
        btn.innerText = "Скачать заново";
    }
});

btn.addEventListener('click', async () => {
    console.log("[Popup] Кнопка загрузки нажата");
    btn.disabled = true;
    statusDiv.innerText = "Ищем информацию о курсе на странице...";
    statusDiv.style.color = "#333";
    progressContainer.style.display = 'none';

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        console.log("[Popup] Активная вкладка:", tab ? tab.url : "нет вкладки");

        if (!tab || (!tab.url.includes("udemy.com/course/") && !tab.url.includes("udemy.com/"))) {
            throw new Error("Пожалуйста, откройте страницу нужного курса на Udemy!");
        }

        console.log("[Popup] Посылаем запрос GET_COURSE_ID в content.js...");
        chrome.tabs.sendMessage(tab.id, { type: 'GET_COURSE_ID' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[Popup] Ошибка связи с content.js:", chrome.runtime.lastError.message);
                statusDiv.innerText = "Ошибка: Content Script не отвечает. Попробуйте обновить страницу с курсом.";
                statusDiv.style.color = "red";
                btn.disabled = false;
                return;
            }

            console.log("[Popup] Ответ от content.js:", response);
            if (response && response.courseId) {
                statusDiv.innerText = `Найден курс ID: ${response.courseId}. Отправка команды в фоновый скрипт...`;
                
                // Передаем команду в background.js
                chrome.runtime.sendMessage({
                    type: 'START_DOWNLOAD',
                    courseId: response.courseId
                }, (bgResponse) => {
                    if (chrome.runtime.lastError) {
                        console.error("[Popup] Ошибка связи с background.js:", chrome.runtime.lastError.message);
                        statusDiv.innerText = "Ошибка фонового скрипта: " + chrome.runtime.lastError.message;
                        statusDiv.style.color = "red";
                        btn.disabled = false;
                    } else {
                        console.log("[Popup] Фоновый скрипт принял команду:", bgResponse);
                    }
                });
            } else {
                console.warn("[Popup] ID курса не найден.");
                statusDiv.innerText = "Ошибка: Не удалось найти ID курса. Убедитесь, что страница полностью загрузилась.";
                statusDiv.style.color = "red";
                btn.disabled = false;
            }
        });
    } catch (e) {
        console.error("[Popup] Пойманная ошибка:", e);
        statusDiv.innerText = e.message;
        statusDiv.style.color = "red";
        btn.disabled = false;
    }
});
