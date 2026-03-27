console.log("[Content Script] Скрипт Udemy Subtitle Downloader запущен на:", window.location.href);

function extractCourseId() {
    console.log("[Content Script] Попытка найти Course ID...");
    
    // 1. Ищем udemy_com:course_id
    const metaEl = document.querySelector('meta[property="udemy_com:course_id"]');
    if (metaEl && metaEl.content) {
        console.log("[Content Script] Успех: найден ID в meta udemy_com:course_id ->", metaEl.content);
        return metaEl.content;
    }

    // 2. Ищем data-clp-course-id в body
    const bodyEl = document.querySelector('body[data-clp-course-id]');
    if (bodyEl) {
        const id = bodyEl.getAttribute('data-clp-course-id');
        console.log("[Content Script] Успех: найден ID в body[data-clp-course-id] ->", id);
        return id;
    }

    // 3. Ищем в .ud-app-loader
    const appLoader = document.querySelector('.ud-app-loader[data-module-args]');
    if (appLoader) {
        try {
            const args = appLoader.getAttribute('data-module-args');
            const match = args.match(/"courseId"\s*:\s*(\d+)/) || args.match(/&quot;courseId&quot;\s*:\s*(\d+)/);
            if (match && match[1]) {
                console.log("[Content Script] Успех: найден ID в .ud-app-loader[data-module-args] ->", match[1]);
                return match[1];
            }
        } catch (e) {
            console.warn("Ошибка при парсинге data-module-args:", e);
        }
    }

    // 4. Ищем og:image (часто содержит courseId в URL картинки)
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage && ogImage.content) {
        const match = ogImage.content.match(/\/course\/(?:\d+x\d+\/)?(\d+)_/);
        if (match && match[1]) {
            console.log("[Content Script] Успех: найден ID в og:image ->", match[1]);
            return match[1];
        }
    }

    // 5. Ищем во всех элементах [data-module-args]
    const allArgsElements = document.querySelectorAll('[data-module-args]');
    for (let el of allArgsElements) {
        const args = el.getAttribute('data-module-args') || '';
        const match = args.match(/"courseId"\s*:\s*(\d+)/) || args.match(/&quot;courseId&quot;\s*:\s*(\d+)/);
        if (match && match[1]) {
            console.log("[Content Script] Успех: найден ID во вложенном data-module-args ->", match[1]);
            return match[1];
        }
    }

    // 6. Пытаемся вытащить из всех тегов script
    console.log("[Content Script] Ищем в тегах script...");
    const scripts = document.querySelectorAll('script');
    for (let s of scripts) {
        const text = s.innerText || '';
        const match = text.match(/&quot;courseId&quot;:(\d+)/) || text.match(/"courseId":(\d+)/);
        if (match && match[1]) {
            console.log("[Content Script] Успех: найден ID в скрипте ->", match[1]);
            return match[1];
        }
    }

    console.warn("[Content Script] ПРОВАЛ: Course ID не найден ни одним из методов.");
    return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[Content Script] Получено сообщение:", message);
    if (message.type === 'GET_COURSE_ID') {
        const id = extractCourseId();
        sendResponse({ courseId: id });
    }
    return true; // Keep the message channel open for sendResponse
});
