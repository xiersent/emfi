document.addEventListener("DOMContentLoaded", function() {
    // DOM элементы
    const loadBtn = document.getElementById('load-btn');
    const domainInput = document.getElementById('domain');
    const apiKeyInput = document.getElementById('api-key');
    const errorContainer = document.getElementById('error');
    const dealsAccordion = document.getElementById('deals-accordion');

    // Конфигурация
    const dealsPerLoad = 2;
    const requestTimeout = 15000;
    const taskRequestTimeout = 20000;
    const requestDelay = 1000;

    // Прокси-серверы
    const proxyUrls = [
        'https://corsproxy.io/?',
        'https://api.codetabs.com/v1/proxy/?quest=',
        'https://cors-anywhere.herokuapp.com/',
        'https://thingproxy.freeboard.io/fetch/'
    ];

    // Состояние приложения
    const state = {
        allDeals: [],
        currentPage: 1,
        loadedDealIds: new Set(),
        shouldStop: false,
        currentlyOpenedDealId: null,
        activeTasksController: null,
        isLastPage: false,
        requestQueue: [],
        isProcessingQueue: false,
        isLoading: false,
        retryCount: 0,
        maxRetries: 5
    };

    // Инициализация
    loadBtn.addEventListener('click', loadDealsHandler);

    // Основные обработчики
    async function loadDealsHandler() {
        resetLoadingState();
        
        const domain = domainInput.value.trim();
        const apiKey = apiKeyInput.value.trim();

        if (!validateInputs(domain, apiKey)) return;

        startLoading();
        
        try {
            // Начинаем загрузку сразу с первой страницы
            addToQueue({
                type: 'deals',
                domain: domain,
                apiKey: apiKey,
                page: state.currentPage
            });
            processQueue();
        } catch (error) {
            handleLoadError(error);
        }
    }

    // Система очереди запросов
    function addToQueue(request) {
        state.requestQueue.push(request);
        if (!state.isProcessingQueue && !state.isLoading) {
            processQueue();
        }
    }

    async function processQueue() {
        if (state.isProcessingQueue || state.requestQueue.length === 0 || state.isLoading) return;
        
        state.isProcessingQueue = true;
        
        while (state.requestQueue.length > 0 && !state.shouldStop) {
            const request = state.requestQueue[0];
            
            try {
                state.isLoading = true;
                
                if (request.type === 'deals') {
                    await processDealsRequest(request.domain, request.apiKey, request.page);
                } else if (request.type === 'tasks') {
                    await processTasksRequest(request.domain, request.apiKey, request.dealId);
                }
                
                // Успешно обработан - удаляем из очереди
                state.requestQueue.shift();
                state.retryCount = 0;
                
                // Задержка между запросами
                await new Promise(resolve => setTimeout(resolve, requestDelay));
            } catch (error) {
                console.error('Ошибка обработки запроса:', error);
                state.retryCount++;
                
                if (state.retryCount >= state.maxRetries) {
                    // Превышено количество попыток
                    state.requestQueue.shift();
                    state.retryCount = 0;
                    
                    if (request.type === 'tasks') {
                        // Для задач показываем кнопку повторной попытки
                        const tasksContainer = document.getElementById(`tasks-${request.dealId}`);
                        if (tasksContainer) {
                            showTaskRetry(tasksContainer, request.dealId);
                        }
                    } else if (error.name !== 'AbortError') {
                        showError(`Ошибка: ${error.message}`);
                    }
                } else {
                    // Повторная попытка после задержки
                    await new Promise(resolve => setTimeout(resolve, 2000 * state.retryCount));
                }
            } finally {
                state.isLoading = false;
            }
        }
        
        state.isProcessingQueue = false;
        
        // Проверяем завершение загрузки
        if (state.requestQueue.length === 0 && !state.isLoading) {
            stopLoading();
        }
    }

    async function processDealsRequest(domain, apiKey, page) {
        const dealsData = await fetchWithRetry(
            () => fetchDeals(domain, apiKey, page),
            `Загрузка сделок (страница ${page})`
        );
        
        if (!dealsData || !dealsData._embedded || !dealsData._embedded.leads || dealsData._embedded.leads.length === 0) {
            state.isLastPage = true;
            handleAllDealsLoaded();
            return;
        }

        processNewDeals(dealsData._embedded.leads, domain, apiKey);
        state.currentPage++;

        // Проверяем есть ли следующая страница
        if (dealsData._links?.next) {
            // Добавляем следующий запрос в очередь
            addToQueue({
                type: 'deals',
                domain: domain,
                apiKey: apiKey,
                page: state.currentPage
            });
        } else {
            state.isLastPage = true;
            handleAllDealsLoaded();
        }
    }

    async function processTasksRequest(domain, apiKey, dealId) {
        const tasksContainer = document.getElementById(`tasks-${dealId}`);
        if (!tasksContainer) return;

        // Показываем прелоадер
        tasksContainer.innerHTML = `
            <div class="loading-tasks">
                <svg class="spinner" viewBox="0 0 50 50">
                    <circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle>
                </svg>
                <span>Загрузка задач...</span>
            </div>
        `;

        try {
            const tasks = await fetchTasksForDeal(domain, apiKey, dealId);
            
            if (state.currentlyOpenedDealId !== dealId) return;
            
            renderTasks(tasksContainer, tasks);
        } catch (error) {
            if (state.currentlyOpenedDealId === dealId) {
                throw error; // Пробрасываем ошибку для обработки в очереди
            }
        }
    }

    // Функции работы с API
    async function fetchDeals(domain, apiKey, page) {
        const apiUrl = `https://${domain}/api/v4/leads?page=${page}&limit=${dealsPerLoad}`;
        return fetchThroughProxy(apiUrl, apiKey);
    }

    async function fetchTasksForDeal(domain, apiKey, dealId) {
        if (state.activeTasksController) {
            state.activeTasksController.abort();
        }
        
        const apiUrl = `https://${domain}/api/v4/tasks?filter[entity_id]=${dealId}&filter[entity_type]=lead`;
        state.activeTasksController = new AbortController();
        const timeoutId = setTimeout(() => {
            state.activeTasksController.abort();
        }, taskRequestTimeout);

        try {
            const result = await fetchThroughProxy(
                apiUrl, 
                apiKey, 
                state.activeTasksController.signal
            );
            return result?._embedded?.tasks || [];
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function fetchThroughProxy(url, apiKey, signal) {
        let lastError = null;
        
        const shuffledProxyUrls = [...proxyUrls].sort(() => Math.random() - 0.5);
        
        for (const proxyUrl of shuffledProxyUrls) {
            try {
                const fullUrl = proxyUrl.includes('?') 
                    ? `${proxyUrl}${encodeURIComponent(url)}` 
                    : `${proxyUrl}${url}`;
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), requestTimeout);
                
                if (signal) {
                    signal.addEventListener('abort', () => controller.abort());
                }
                
                const response = await fetch(fullUrl, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    lastError = new Error(`HTTP ошибка: ${response.status}`);
                    continue;
                }

                return await response.json();
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                lastError = error;
                continue;
            }
        }
        
        throw lastError || new Error('Все прокси серверы недоступны');
    }

    async function fetchWithRetry(fetchFunction, description = '', maxRetries = 3) {
        let lastError = null;
        
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fetchFunction();
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                lastError = error;
                console.warn(`Попытка ${i + 1} не удалась (${description}):`, error);
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
        
        throw lastError || new Error(`Не удалось выполнить запрос после ${maxRetries} попыток`);
    }

    // Функции рендеринга
    function renderDeals(domain, apiKey) {
        const prevOpenedDealId = state.currentlyOpenedDealId;
        state.currentlyOpenedDealId = null;
        
        dealsAccordion.innerHTML = state.allDeals.map((deal, index) => {
            const formattedDate = deal.created_at ? formatDate(deal.created_at) : '';
            
            return `
                <div class="aaa-accordion__item">
                    <input type="radio" name="accordion" id="deal-${deal.id}" class="aaa-accordion__input">
                    <label for="deal-${deal.id}" class="aaa-accordion__header">
                        <span>${index + 1}. ${deal.name || 'Без названия'}</span>
                    </label>
                    <div class="aaa-accordion__content">
                        <div class="aaa-deal__info">
                            <p><strong>ID:</strong> ${deal.id}</p>
                            ${formattedDate ? `<p><strong>Создана:</strong> ${formattedDate}</p>` : ''}
                            <div class="aaa-deal__tasks" id="tasks-${deal.id}"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        if (prevOpenedDealId) {
            const dealInput = document.getElementById(`deal-${prevOpenedDealId}`);
            if (dealInput) {
                dealInput.checked = true;
                state.currentlyOpenedDealId = prevOpenedDealId;
                addToQueue({
                    type: 'tasks',
                    domain: domain,
                    apiKey: apiKey,
                    dealId: prevOpenedDealId
                });
            }
        }

        document.querySelectorAll('.aaa-accordion__input').forEach(input => {
            input.addEventListener('change', function() {
                const dealId = this.id.replace('deal-', '');
                if (this.checked) {
                    state.currentlyOpenedDealId = dealId;
                    addToQueue({
                        type: 'tasks',
                        domain: domainInput.value.trim(),
                        apiKey: apiKeyInput.value.trim(),
                        dealId: dealId
                    });
                } else {
                    state.currentlyOpenedDealId = null;
                }
            });
        });
    }

    function renderTasks(container, tasks) {
        if (!tasks || tasks.length === 0) {
            container.innerHTML = `
                <div class="task-status-line">
                    <svg class="status-circle" viewBox="0 0 20 20" width="16" height="16">
                        <circle cx="10" cy="10" r="8" fill="#ff0000"/>
                    </svg>
                    <p>Не удалось загрузить задачи</p>
                </div>
            `;
            return;
        }

        const sortedTasks = [...tasks].sort((a, b) => (a.complete_till || 0) - (b.complete_till || 0));

        container.innerHTML = `
            <div class="task-list">
                ${sortedTasks.map(task => `
                    <div class="task-item">
                        <div class="task-status-line">
                            <svg class="status-circle" viewBox="0 0 20 20" width="16" height="16">
                                <circle cx="10" cy="10" r="8" fill="${getTaskStatusColor(task)}"/>
                            </svg>
                            <div class="task-info">
                                <p class="task-text">${task.text || 'Без описания'}</p>
                                ${task.complete_till ? `<p class="task-date">${formatTaskDate(task.complete_till)}</p>` : ''}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function showTaskRetry(container, dealId) {
        container.innerHTML = `
            <div class="task-retry">
                <svg class="status-circle" viewBox="0 0 20 20" width="16" height="16">
                    <circle cx="10" cy="10" r="8" fill="#ff0000"/>
                </svg>
                <p>Ошибка загрузки задач</p>
                <button class="retry-btn" data-deal-id="${dealId}">Попробовать снова</button>
            </div>
        `;

        container.querySelector('.retry-btn').addEventListener('click', () => {
            addToQueue({
                type: 'tasks',
                domain: domainInput.value.trim(),
                apiKey: apiKeyInput.value.trim(),
                dealId: dealId
            });
            processQueue();
        });
    }

    function showTaskError(container, message) {
        container.innerHTML = `
            <div class="task-status-line">
                <svg class="status-circle" viewBox="0 0 20 20" width="16" height="16">
                    <circle cx="10" cy="10" r="8" fill="#ff0000"/>
                </svg>
                <p>${message}</p>
            </div>
        `;
    }

    // Вспомогательные функции
    function formatDate(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp * 1000);
        return date.toLocaleDateString('ru-RU');
    }

    function formatTaskDate(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp * 1000);
        return date.toLocaleString('ru-RU');
    }

    function getTaskStatusColor(task) {
        if (!task.complete_till) return '#FFC107';
        
        const now = Math.floor(Date.now() / 1000);
        if (task.complete_till < now) return '#ff0000';
        
        const taskDate = new Date(task.complete_till * 1000);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (taskDate.getDate() === today.getDate() && 
            taskDate.getMonth() === today.getMonth() && 
            taskDate.getFullYear() === today.getFullYear()) {
            return '#4CAF50';
        }
        
        return '#FFC107';
    }

    function validateInputs(domain, apiKey) {
        if (!domain || !apiKey) {
            showError("Пожалуйста, заполните все поля");
            return false;
        }
        return true;
    }

    function processNewDeals(newDeals, domain, apiKey) {
        const filteredDeals = newDeals.filter(deal => {
            if (state.loadedDealIds.has(deal.id)) return false;
            state.loadedDealIds.add(deal.id);
            return true;
        });

        if (filteredDeals.length) {
            state.allDeals = [...state.allDeals, ...filteredDeals];
            renderDeals(domain, apiKey);
        }
    }

    function resetLoadingState() {
        state.allDeals = [];
        state.currentPage = 1;
        state.loadedDealIds.clear();
        state.shouldStop = false;
        state.currentlyOpenedDealId = null;
        state.isLastPage = false;
        state.requestQueue = [];
        state.isProcessingQueue = false;
        state.isLoading = false;
        state.retryCount = 0;
        
        if (state.activeTasksController) {
            state.activeTasksController.abort();
            state.activeTasksController = null;
        }
        
        dealsAccordion.innerHTML = '';
        errorContainer.style.display = 'none';
    }

    function handleAllDealsLoaded() {
        if (!state.shouldStop) {
            showInfo(`Загружено ${state.allDeals.length} сделок`);
            state.shouldStop = true;
        }
    }

    function handleLoadError(error) {
        console.error('Ошибка загрузки:', error);
        state.shouldStop = true;
        showError(`Ошибка: ${error.message}`);
        stopLoading();
    }

    function startLoading() {
        loadBtn.disabled = true;
        loadBtn.textContent = "Загрузка...";
        errorContainer.textContent = "";
        errorContainer.style.display = 'none';
    }

    function stopLoading() {
        loadBtn.disabled = false;
        loadBtn.textContent = "Загрузить сделки";
    }

    function showError(message) {
        errorContainer.textContent = message;
        errorContainer.style.color = '#ff0000';
        errorContainer.style.display = 'block';
    }

    function showInfo(message) {
        errorContainer.textContent = message;
        errorContainer.style.color = '#4CAF50';
        errorContainer.style.display = 'block';
    }
});