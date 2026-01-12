// --- Global variables for UI controls ---
let autoRefreshInterval;
let isAutoRefreshPaused = false;

document.addEventListener('DOMContentLoaded', () => {
    // --- Authentication Check ---
    const token = localStorage.getItem('jwt_token');
    if (!token) {
        window.location.href = '/manager.html';
        return;
    }

    // --- Element Selectors ---
    const clientsTableBody = document.querySelector('#clients-table tbody');
    const searchInput = document.getElementById('search-input');
    const toggleRefreshButton = document.getElementById('toggle-refresh');
    const addClientButton = document.getElementById('add-client-button');
    const restartServerButton = document.getElementById('restart-server-button');
    const logoutButton = document.getElementById('logout-button');
    const closeModalButton = document.getElementById('close-modal-button');
    const closeChatsModalButton = document.getElementById('close-chats-modal-button');
    const sendMessageForm = document.getElementById('send-message-form');

    // --- Helper for API calls ---
    const getAuthHeaders = () => ({
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    });

    // --- Event Listeners ---
    logoutButton.addEventListener('click', logout);
    restartServerButton.addEventListener('click', restartServer);
    addClientButton.addEventListener('click', () => addOrCheckClient());
    toggleRefreshButton.addEventListener('click', toggleAutoRefresh);
    searchInput.addEventListener('keyup', filterClients);
    closeModalButton.addEventListener('click', closeQrModal);
    closeChatsModalButton.addEventListener('click', closeChatsModal);
    sendMessageForm.addEventListener('submit', sendTestMessage);

    // Event Delegation for table actions
    clientsTableBody.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;

        const action = button.dataset.action;
        const companyId = button.dataset.companyId;

        switch (action) {
            case 'view':
                addOrCheckClient(companyId);
                break;
            case 'chats':
                viewRecentChats(companyId);
                break;
            case 'restart':
                restartClient(companyId);
                break;
            case 'disconnect':
                disconnectClient(companyId);
                break;
            case 'delete':
                deleteClient(companyId);
                break;
        }
    });

    // --- UI Control Functions ---
    function toggleAutoRefresh() {
        isAutoRefreshPaused = !isAutoRefreshPaused;
        if (isAutoRefreshPaused) {
            toggleRefreshButton.textContent = 'Reanudar';
            toggleRefreshButton.style.backgroundColor = '#ff9800';
        } else {
            toggleRefreshButton.textContent = 'Pausar';
            toggleRefreshButton.style.backgroundColor = '#4CAF50';
        }
    }

    function filterClients() {
        const filter = searchInput.value.toUpperCase();
        const tr = clientsTableBody.getElementsByTagName('tr');
        for (let i = 0; i < tr.length; i++) {
            const td = tr[i].getElementsByTagName('td')[0];
            if (td) {
                const txtValue = td.textContent || td.innerText;
                tr[i].style.display = txtValue.toUpperCase().indexOf(filter) > -1 ? '' : 'none';
            }
        }
    }

    // --- Data Fetching Functions ---
    async function fetchServerStatus() {
        try {
            const response = await fetch('/server-status', { headers: getAuthHeaders() });
            if (response.status === 401 || response.status === 403) return logout();
            const data = await response.json();
            const statusSpan = document.getElementById('server-status');
            statusSpan.textContent = data.status;
            statusSpan.style.color = data.status === 'online' ? '#4CAF50' : '#f44336';
            document.getElementById('server-cpu').textContent = data.cpu;
            document.getElementById('server-memory').textContent = data.memory;
        } catch (error) {
            console.error('Error al cargar el estado del servidor:', error);
            const statusSpan = document.getElementById('server-status');
            statusSpan.textContent = 'Error';
            statusSpan.style.color = '#f44336';
        }
    }

    async function fetchClients() {
        try {
            const response = await fetch('/connected-clients', { headers: getAuthHeaders() });
            if (response.status === 401 || response.status === 403) return logout();
            const clients = await response.json();
            
            clientsTableBody.innerHTML = '';
            const clientSelect = document.getElementById('client-select');
            const currentSelectedValue = clientSelect.value;
            clientSelect.innerHTML = ''; // Clear previous options

            clients.forEach(client => {
                // Populate table row
                const row = clientsTableBody.insertRow();
                const statusClass = getStatusClass(client.status_detail);
                row.innerHTML = `
                    <td>${client.company_id}</td>
                    <td>${client.phoneNumber || 'N/A'}</td>
                    <td>${client.pushname || 'N/A'}</td>
                    <td class="${statusClass}">${client.status_detail}</td>
                    <td>${client.error_message || 'N/A'}</td>
                    <td>
                        <button data-action="view" data-company-id="${client.company_id}">Ver / QR</button>
                        <button data-action="chats" data-company-id="${client.company_id}" style="background-color: #2196F3;">Ver Chats</button>
                        <button data-action="restart" data-company-id="${client.company_id}">Reiniciar</button>
                        <button data-action="disconnect" data-company-id="${client.company_id}">Desconectar</button>
                        <button data-action="delete" data-company-id="${client.company_id}" style="background-color: #f44336; color: white;">Eliminar</button>
                    </td>
                `;

                // Populate select dropdown if client is ready
                if (client.status_detail === 'READY') {
                    const option = document.createElement('option');
                    option.value = client.company_id;
                    option.textContent = `${client.pushname || client.company_id} (${client.phoneNumber})`;
                    clientSelect.appendChild(option);
                }
            });

            // Restore selection if possible
            if (currentSelectedValue) {
                clientSelect.value = currentSelectedValue;
            }

            document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
            filterClients(); // Re-apply filter after fetching
        } catch (error) {
            console.error('Error al cargar los clientes:', error);
        }
    }

    async function sendTestMessage(event) {
        event.preventDefault();
        const companyId = document.getElementById('client-select').value;
        const phone = document.getElementById('phone-input').value;
        const message = document.getElementById('message-input').value;

        if (!companyId) {
            return alert('Por favor, selecciona un cliente desde el cual enviar el mensaje.');
        }
        if (!phone || !message) {
            return alert('Por favor, introduce un número de teléfono y un mensaje.');
        }

        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        button.textContent = 'Enviando...';

        try {
            const response = await fetch(`/send-message-basic/${companyId}`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ phone, message })
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || 'Error en el servidor');
            }
            alert('Mensaje enviado exitosamente.');
            document.getElementById('message-input').value = ''; // Clear message input on success
        } catch (error) {
            console.error('Error al enviar mensaje de prueba:', error);
            alert(`Error al enviar mensaje: ${error.message}`);
        } finally {
            button.disabled = false;
            button.textContent = 'Enviar Mensaje';
        }
    }

    function getStatusClass(status) {
        if (status === 'READY') return 'status-ready';
        if (status === 'REQUIRES_QR') return 'status-requires_qr';
        if (status === 'ERROR') return 'status-error';
        if (status === 'STARTING') return 'status-starting';
        return '';
    }

    // --- Action Functions ---
    async function addOrCheckClient(clientIdFromButton = null) {
        const clientId = clientIdFromButton || document.getElementById('new-client-id').value.trim();
        if (!clientId) return alert('Por favor, introduce un Company ID.');
        try {
            const response = await fetch(`/session-info/${clientId}`, { headers: getAuthHeaders() });
            if (response.status === 401 || response.status === 403) return logout();
            const data = await response.json();
            if (data.qr) {
                showQrModal(clientId, data.qr);
            } else {
                alert(`Estado para ${clientId}: ${data.message}`);
            }
            fetchClients();
        } catch (error) {
            console.error(`Error al añadir o consultar el cliente ${clientId}:`, error);
            alert(`Error al procesar la solicitud para ${clientId}.`);
        }
    }

    async function restartClient(clientId) {
        if (!confirm(`¿Estás seguro de que quieres reiniciar el cliente ${clientId}?`)) return;
        try {
            const response = await fetch(`/restart/${clientId}`, { method: 'POST', headers: getAuthHeaders() });
            if (response.status === 401 || response.status === 403) return logout();
            const data = await response.json();
            alert(data.message);
            setTimeout(fetchClients, 2000);
        } catch (error) {
            console.error(`Error al reiniciar el cliente ${clientId}:`, error);
            alert(`Error al reiniciar el cliente ${clientId}.`);
        }
    }

    async function disconnectClient(clientId) {
        if (!confirm(`¿Deseas desconectar el cliente ${clientId}? La sesión se cerrará, pero los datos no se eliminarán.`)) return;
        try {
            const response = await fetch(`/disconnect/${clientId}`, { method: 'DELETE', headers: getAuthHeaders() });
            if (response.status === 401 || response.status === 403) return logout();
            const data = await response.json();
            alert(data.message);
            fetchClients();
        } catch (error) {
            console.error(`Error al desconectar el cliente ${clientId}:`, error);
            alert(`Error al desconectar el cliente ${clientId}.`);
        }
    }

    async function deleteClient(clientId) {
        if (!confirm(`¡ATENCIÓN!\n\n¿Estás seguro de que quieres ELIMINAR POR COMPLETO el cliente ${clientId}?`)) return;
        try {
            const response = await fetch(`/client/${clientId}`, { method: 'DELETE', headers: getAuthHeaders() });
            if (response.status === 401 || response.status === 403) return logout();
            const data = await response.json();
            alert(data.message);
            fetchClients();
        } catch (error) {
            console.error(`Error al eliminar el cliente ${clientId}:`, error);
            alert(`Error al eliminar el cliente ${clientId}.`);
        }
    }

    async function restartServer() {
        if (!confirm('¡ATENCIÓN!\n\n¿Estás seguro de que quieres reiniciar TODO el servidor?')) return;
        alert('Se ha enviado la señal de reinicio. El panel se recargará en unos segundos...');
        try {
            await fetch('/restart-server', { method: 'POST', headers: getAuthHeaders() });
        } catch (error) {
            console.warn('Se esperaba un error de red durante el reinicio del servidor:', error);
        }
        setTimeout(() => window.location.reload(), 5000);
    }

    // --- Modal Functions ---
    function showQrModal(clientId, qrCodeImage) {
        document.getElementById('qr-client-id').innerText = `QR para: ${clientId}`;
        document.getElementById('qr-code-container').innerHTML = `<img src="${qrCodeImage}" alt="Código QR para ${clientId}">`;
        document.getElementById('qr-modal').style.display = 'block';
    }

    function closeQrModal() {
        document.getElementById('qr-modal').style.display = 'none';
    }

    async function viewRecentChats(companyId) {
        const modal = document.getElementById('chats-modal');
        const title = document.getElementById('chats-client-id');
        const container = document.getElementById('chats-list-container');

        title.textContent = `Chats Recientes para: ${companyId}`;
        container.innerHTML = '<p>Cargando chats...</p>';
        modal.style.display = 'block';

        try {
            const response = await fetch(`/chats/${companyId}`, { headers: getAuthHeaders() });
            if (response.status === 401 || response.status === 403) return logout();
            if (!response.ok) {
                throw new Error(`Error del servidor: ${response.statusText}`);
            }

            const chats = await response.json();

            if (chats.length === 0) {
                container.innerHTML = '<p>No se encontraron chats recientes.</p>';
                return;
            }

            let html = '<ul style="list-style: none; padding: 0;">';
            chats.forEach(chat => {
                html += `
                    <li style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #555;">
                        <strong>${chat.name || chat.id}</strong> <span style="color: #4CAF50; font-weight: bold;">${chat.unreadCount > 0 ? `(${chat.unreadCount})` : ''}</span><br>
                        <small style="color: #ccc;"><em>${chat.lastMessage ? chat.lastMessage.substring(0, 80) + '...' : 'Sin mensajes'}</em></small>
                    </li>
                `;
            });
            html += '</ul>';
            container.innerHTML = html;

        } catch (error) {
            console.error(`Error al cargar los chats para ${companyId}:`, error);
            container.innerHTML = `<p style="color: #f44336;">Error al cargar los chats. ${error.message}</p>`;
        }
    }

    function closeChatsModal() {
        document.getElementById('chats-modal').style.display = 'none';
    }

    // --- Auth Functions ---
    function logout() {
        localStorage.removeItem('jwt_token');
        window.location.href = '/manager.html';
    }

    // --- Initial Load ---
    fetchClients();
    fetchServerStatus();
    autoRefreshInterval = setInterval(() => {
        if (!isAutoRefreshPaused) {
            fetchClients();
            fetchServerStatus();
        }
    }, 5000);
});