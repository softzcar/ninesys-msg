const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const loadTemplates = require("../templates/templates-loader");
const templates = loadTemplates();

const fs = require('fs').promises;
const path = require('path');

// Objeto para almacenar instancias de clientes de WhatsApp por companyId
// La estructura será clients = { 'companyId1': { client: ClientInstance, whatsappReady: boolean, qrCodeImage: string | null, error?: Error }, ... }
const clients = {};

// --- Función para inicializar un cliente (ya existente, ligeramente mejorada) ---
const initializeClient = (companyId) => {
    console.log(`Intentando inicializar/registrar cliente para companyId: ${companyId}`);

    // Si ya existe una instancia de cliente para este ID, no hacemos nada (a menos que sea por un reinicio explícito)
    // Esta función está diseñada para asegurar *un* proceso de inicialización por ID.
    if (clients[companyId] && clients[companyId].client) {
        console.log(`Cliente con instancia activa ya registrado para ${companyId}.`);
        // Podrías añadir aquí lógica para verificar el estado si quisieras ser más proactivo
        return;
    }

    // Si no existe la entrada o no tiene instancia activa, preparamos o limpiamos la entrada
    if (!clients[companyId]) {
        clients[companyId] = { whatsappReady: false, qrCodeImage: null, client: null };
        console.log(`Creando entrada inicial en memoria para companyId: ${companyId}.`);
    } else {
        // Limpiar estado anterior si existía la entrada pero no la instancia activa (ej: después de un disconnect o error)
        clients[companyId].whatsappReady = false;
        clients[companyId].qrCodeImage = null;
        delete clients[companyId].client; // Asegurarse de no tener una referencia antigua
        delete clients[companyId].error; // Limpiar cualquier error previo
        console.log(`Limpiando estado previo en memoria para companyId: ${companyId} antes de inicializar.`);
    }


    const client = new Client({
        authStrategy: new LocalAuth({ clientId: companyId }),
        puppeteer: {
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--no-first-run",
                "--no-zygote",
                "--single-process",
                "--window-size=1920,1080",
                "--disable-gpu"
            ],
        },
    });

    clients[companyId].client = client; // Guardar la instancia del nuevo cliente

    // --- Configuración de Listeners (igual que antes) ---
    client.on("qr", (qr) => {
        console.log(`Evento QR recibido para ${companyId}.`);
        qrcode.toDataURL(qr, (err, qrCodeImage) => {
            if (err) {
                console.error(
                    `Error al generar el código QR para ${companyId}:`,
                    err
                );
                if (clients[companyId]) clients[companyId].error = err;
            } else {
                if (clients[companyId]) clients[companyId].qrCodeImage = qrCodeImage;
                console.log(
                    `QR generado y almacenado para ${companyId}. Escanéalo para vincular el dispositivo.`
                );
                // Emitir evento WebSocket aquí si lo usas
            }
        });
    });

    client.on("ready", () => {
        console.log(
            `Cliente de WhatsApp listo para ${companyId}. Ya puedes enviar mensajes.`
        );
        if (clients[companyId]) {
            clients[companyId].whatsappReady = true;
            clients[companyId].qrCodeImage = null; // QR no necesario cuando está listo
            delete clients[companyId].error; // Limpiar errores
        }
        // Emitir evento WebSocket aquí si lo usas
    });

    client.on("authenticated", () => {
        console.log(
            `Cliente de WhatsApp autenticado correctamente para ${companyId}.`
        );
        // El evento 'ready' es el que confirma que está listo para mensajes
    });

    client.on("auth_failure", (msg) => {
        console.error(`Fallo en la autenticación para ${companyId}:`, msg);
        if (clients[companyId]) {
            clients[companyId].whatsappReady = false;
            clients[companyId].qrCodeImage = null;
            clients[companyId].error = new Error(`Auth failure: ${msg}`);
            // No elimines la instancia aquí si quieres permitir un nuevo intento de inicialización/QR
        }
        // Emitir evento WebSocket aquí si lo usas
    });

    client.on("disconnected", (reason) => {
        console.log(
            `Cliente de WhatsApp desconectado para ${companyId}:`,
            reason
        );
        if (clients[companyId]) {
            clients[companyId].whatsappReady = false;
            clients[companyId].qrCodeImage = null;
            // delete clients[companyId].client; // Puedes decidir si eliminas la instancia o la mantienes para un posible reintento automático por parte de wwebjs
            clients[companyId].error = new Error(`Disconnected: ${reason}`);
        }
        // Emitir evento WebSocket aquí si lo usas
        // Considerar lógica de reintento automático aquí o en un supervisor
    });

    client.on("change_state", (state) => {
        console.log(
            `Estado del cliente para ${companyId} cambiado a: ${state}`
        );
        // clients[companyId].whatsappReady = state === "CONNECTED"; // 'ready' es más fiable
        if (clients[companyId]) clients[companyId].status = state; // Guardar estado detallado si quieres
    });

    client.on("message", async (msg) => {
        // ... (lógica de manejo de mensajes igual que antes)
        try {
            if (!msg.isStatus) { // Ignorar historias de estado
                console.log(
                    `Mensaje recibido para ${companyId} de ${msg._data.notifyName}: ${msg.body}`
                );
                // Tu lógica para procesar mensajes entrantes aquí
            }
        } catch (error) {
            console.error(`Error al procesar mensaje entrante para ${companyId}:`, error);
        }
    });

    // Iniciar el cliente
    client.initialize().catch(err => {
        console.error(`Error durante client.initialize() para ${companyId}:`, err);
        if (clients[companyId]) {
            clients[companyId].whatsappReady = false;
            clients[companyId].qrCodeImage = null;
            clients[companyId].error = err;
            delete clients[companyId].client; // Eliminar instancia si initialize falla fatalmente
        }
    });

    console.log(`Proceso de inicialización (client.initialize()) invocado para ${companyId}.`);
}


// --- NUEVA FUNCIÓN: Inicializar todos los clientes con sesiones guardadas ---
const initializeAllClientsFromSessions = async () => {
    console.log("--- Iniciando carga de sesiones existentes al inicio de la aplicación ---");
    // Asegúrate de que esta ruta es correcta relativa a la raíz de tu proyecto Docker
    // __dirname es el directorio actual (donde está whatsappController.js),
    // '..' sube un nivel (al directorio 'controllers' si está en src/controllers),
    // '..' sube otro nivel (a la raíz del proyecto si 'controllers' está directo en src)
    const sessionsDir = path.join(__dirname, '..', '.wwebjs_auth');

    try {
        // Leer el contenido del directorio .wwebjs_auth
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true });

        // Filtrar para encontrar solo directorios que empiezan con 'session-'
        const sessionFolders = entries
            .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('session-'))
            .map(dirent => dirent.name);

        if (sessionFolders.length === 0) {
            console.log("No se encontraron carpetas de sesión existentes en:", sessionsDir);
            return;
        }

        console.log(`Se encontraron ${sessionFolders.length} sesión(es) existente(s): ${sessionFolders.join(', ')}`);

        // Inicializar cada cliente encontrado. Lo hacemos secuencialmente con un pequeño delay
        // para evitar saturar recursos al inicio, aunque podría hacerse en paralelo si es necesario.
        for (const folderName of sessionFolders) {
            const companyId = folderName.replace('session-', ''); // Extraer el companyId del nombre de la carpeta
            console.log(`-> Iniciando proceso de inicialización para companyId: ${companyId} desde sesión guardada.`);
            // Llama a la función initializeClient existente para cada ID encontrado
            initializeClient(companyId);
            // Opcional: pequeño retraso entre inicializaciones
            await new Promise(resolve => setTimeout(resolve, 500)); // Espera 500ms
        }

        console.log("--- Finalizado el proceso de inicialización de sesiones existentes ---");

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`El directorio de sesiones no existe en ${sessionsDir}. No hay sesiones que cargar.`);
        } else {
            console.error(`Error al leer el directorio de sesiones ${sessionsDir}:`, error);
        }
    }
};


// Desconecta y elimina la autenticación local de un cliente
const disconnectClientByCompanyId = async (req, res) => {
    const { companyId } = req.params;

    if (!clients[companyId]) {
        // Si no existe la entrada, ya está "desconectado" y sin archivos de sesión manejados por esta lógica
        return res.status(404).json({
            message: `No se encontró registro de un cliente de WhatsApp para la compañía ${companyId}.`,
        });
    }

    try {
        console.log(`Intentando desconectar y eliminar la autenticación para ${companyId}.`);

        // Si existe una instancia del cliente, desloguearla
        if (clients[companyId].client) {
            await clients[companyId].client.logout();
            console.log(`Cliente desconectado via logout para ${companyId}.`);
            delete clients[companyId].client; // Eliminar la referencia
        }

        // Limpiar la información del cliente en memoria
        clients[companyId].whatsappReady = false;
        clients[companyId].qrCodeImage = null;
        delete clients[companyId].error; // Limpiar errores
        // Opcional: podrías eliminar la entrada completa si no quieres rastrear clientes desconectados
        // delete clients[companyId];


        // Eliminar los archivos de sesión locales
        // Asegúrate de que esta ruta sea correcta relativa a donde se ejecutan los archivos.
        // .wwebjs_auth se crea en el directorio de trabajo, no en el de los controladores.
        const sessionFolderPath = path.join(__dirname, '..', '.wwebjs_auth', `session-${companyId}`);

        try {
            // recursive: true para borrar directorios y force: true para ignorar si no existe
            await fs.rm(sessionFolderPath, { recursive: true, force: true });
            console.log(`Archivos de sesión eliminados para ${companyId} en: ${sessionFolderPath}`);
        } catch (err) {
            // No es un error crítico si los archivos ya no estaban, solo lo registramos
            console.warn(`Advertencia: Error al intentar eliminar archivos de sesión para ${companyId}:`, err);
        }

        res.status(200).json({
            message: `Servicio de WhatsApp desconectado y autenticación local eliminada para la compañía ${companyId}.`,
        });
    } catch (error) {
        console.error(
            `Error al desconectar el cliente de WhatsApp para ${companyId}:`,
            error
        );
        // Aunque hubo un error en logout, intentamos limpiar el estado en memoria y los archivos.
        // Reportamos el error original del logout.
        res.status(500).json({
            message: `Error al desconectar el servicio de WhatsApp para la compañía ${companyId}. Es posible que deba limpiar manualmente.`,
            error: error.toString(),
        });
    }
};


// Retorna la cadena base64 del código QR (si está disponible)
const showQRCodeBasic = (companyId) => {
    if (clients[companyId] && clients[companyId].qrCodeImage) {
        return clients[companyId].qrCodeImage;
    } else if (clients[companyId] && clients[companyId].whatsappReady) {
        return "Cliente conectado. QR no disponible.";
    } else if (clients[companyId] && clients[companyId].error) {
        return `Error: ${clients[companyId].error.message}`;
    }
    else {
        return "Cliente no inicializado o Código QR no disponible";
    }
}

// Muestra la imagen del código QR en una página HTML simple
const showQRCode = (req, res) => {
    const { companyId } = req.params;
    const qrCode = showQRCodeBasic(companyId); // Obtiene la cadena base64 o el mensaje

    if (qrCode && qrCode.startsWith('data:image/png;base64,')) {
        res.send(`<img src="${qrCode}" alt="Código QR para WhatsApp" style="max-width: 300px;">`);
    } else {
        res.status(404).send(`<h3>${qrCode} para ${companyId}.</h3>`);
    }
}

// Envía un mensaje de texto básico
const sendMessage = async (req, res) => {
    const { companyId } = req.params;
    const { phone, name, message } = req.body; // Asumimos que `phone` llega sin formato @c.us

    if (!clients[companyId] || !clients[companyId].whatsappReady) {
        console.error(`Cliente de WhatsApp no está listo para ${companyId}.`);
        return res.status(500).json({
            message: `El cliente de WhatsApp para ${companyId} aún no está listo o no está conectado.`,
        });
    }

    if (!phone || !message) {
        return res.status(400).json({
            message: "Faltan parámetros: número de teléfono y/o mensaje.",
        });
    }

    const formattedPhone = `${phone}@c.us`; // Formato necesario para whatsapp-web.js
    const fullMessage = `Hola ${name || 'cliente'}, ${message}`; // Usar "cliente" si no hay nombre

    try {
        // Pequeño delay opcional para evitar saturar (ajustar si es necesario)
        // await new Promise(resolve => setTimeout(resolve, 500));

        const chat = await clients[companyId].client.getChatById(formattedPhone);
        // Check if the chat exists before sending
        if (!chat) {
            console.warn(`El chat con ${formattedPhone} no existe para ${companyId}. Intentando enviar de todos modos.`);
            // whatsapp-web.js usually creates the chat on the first message, but good to know
        }

        await clients[companyId].client.sendMessage(formattedPhone, fullMessage);
        console.log(
            `Mensaje enviado a ${formattedPhone} para ${companyId}: "${fullMessage}"`
        );

        res.status(200).json({
            message: `Mensaje enviado exitosamente a ${name || phone} para ${companyId}.`,
        });
    } catch (error) {
        console.error(`Error al enviar el mensaje para ${companyId} a ${formattedPhone}:`, error);
        res.status(500).json({
            message: "Error al enviar el mensaje",
            error: error.message, // Envía solo el mensaje del error
        });
    }
}

// Envía un mensaje de texto básico
const sendMessageCustom = async (req, res) => {
    const { companyId } = req.params;
    const { phone, name, message } = req.body; // Asumimos que `phone` llega sin formato @c.us

    if (!clients[companyId] || !clients[companyId].whatsappReady) {
        console.error(`Cliente de WhatsApp no está listo para ${companyId}.`);
        return res.status(500).json({
            message: `El cliente de WhatsApp para ${companyId} aún no está listo o no está conectado.`,
        });
    }

    if (!phone || !message) {
        return res.status(400).json({
            message: "Faltan parámetros: número de teléfono y/o mensaje.",
	    phone: phone,
	    message: message,
        });
    } else {
	console.log('los datos están completos')
    }

    const formattedPhone = `${phone}@c.us`; // Formato necesario para whatsapp-web.js
    const fullMessage = message; // Preparar mensaje

    try {
        // Pequeño delay opcional para evitar saturar (ajustar si es necesario)
        // await new Promise(resolve => setTimeout(resolve, 500));

        const chat = await clients[companyId].client.getChatById(formattedPhone);
        // Check if the chat exists before sending
        if (!chat) {
            console.warn(`El chat con ${formattedPhone} no existe para ${companyId}.Intentando enviar de todos modos.`);
            // whatsapp-web.js usually creates the chat on the first message, but good to know
        } else {
	   console.log('El chat ha sido encontrado')
	}

        await clients[companyId].client.sendMessage(formattedPhone, fullMessage);
        console.log(
            `Mensaje enviado a ${formattedPhone} para ${companyId}: "${fullMessage}"`
        );

        res.status(200).json({
            message: `Mensaje enviado exitosamente a ${name || phone} para ${companyId}.`,
        });
    } catch (error) {
        console.error(`Error al enviar el mensaje para ${companyId} a ${formattedPhone}: `, error);
        res.status(500).json({
            message: "Error al enviar el mensaje",
            error: error.message, // Envía solo el mensaje del error  	    

        });
    }
}

// Envía un mensaje usando plantillas predefinidas
const sendTemplateMessage = async (req, res) => {
    const { companyId } = req.params;
    const { data } = req.body; // data debe contener phone_client, template y otros campos para la plantilla

    // Nota: Aquí se mantenía la inicialización si el cliente no existía.
    // Si quieres que la inicialización sea un paso separado (ej: ruta POST /initialize/:companyId),
    // remueve el siguiente bloque if y el endpoint /session-info también debería inicializar.
    if (!clients[companyId] || !clients[companyId].client) {
        console.warn(`Cliente para ${companyId} no inicializado al intentar enviar plantilla.Inicializando ahora.`);
        initializeClient(companyId);
        // Como la inicialización es async, no podemos garantizar que esté listo inmediatamente.
        // Devolvemos un estado indicando que la inicialización ha comenzado.
        // El frontend o un proceso de fondo debería verificar el estado después.
        return res.status(409).json({ // 409 Conflict o 202 Accepted podrían ser alternativas
            message: `El cliente de WhatsApp para ${companyId} no estaba listo.Se ha iniciado el proceso de inicialización.Intente enviar el mensaje nuevamente en unos instantes.`,
        });
    }

    if (!clients[companyId].whatsappReady) {
        return res.status(503).json({ // 503 Service Unavailable
            message: `El cliente de WhatsApp para ${companyId} no está conectado(estado: ${clients[companyId].client.state || 'desconocido'}).`,
        });
    }


    if (!data || !data.phone_client || !data.template) {
        return res.status(400).json({
            message: "Faltan parámetros: 'data' en el cuerpo, 'phone_client' y 'template' dentro de 'data'.",
        });
    }

    const formattedPhone = `${data.phone_client} @c.us`;
    const templateName = data.template;

    let fullMessage;

    if (templates[templateName]) {
        try {
            // La función de plantilla toma el objeto 'data' completo
            fullMessage = templates[templateName](data);
            if (typeof fullMessage !== 'string' || fullMessage.length === 0) {
                throw new Error(`La plantilla '${templateName}' generó un mensaje inválido.`);
            }
        } catch (templateError) {
            console.error(`Error al procesar la plantilla '${templateName}' para ${companyId}: `, templateError);
            return res.status(400).json({
                message: `Error al procesar la plantilla '${templateName}'.`,
                error: templateError.message,
            });
        }
    } else {
        return res.status(404).json({
            message: `Template '${templateName}' no encontrado.`,
        });
    }

    try {
        // Pequeño delay opcional
        // await new Promise(resolve => setTimeout(resolve, 500));

        const chat = await clients[companyId].client.getChatById(formattedPhone);
        if (!chat) {
            console.warn(`El chat con ${formattedPhone} no existe para ${companyId}. Intentando enviar plantilla de todos modos.`);
        }

        await clients[companyId].client.sendMessage(formattedPhone, fullMessage);
        console.log(
            `Mensaje de plantilla('${templateName}') enviado a ${formattedPhone} para ${companyId}: "${fullMessage}"`
        );

        res.status(200).json({
            message: `Mensaje de plantilla '${templateName}' enviado exitosamente a ${data.first_name || data.phone_client} para ${companyId}.`,
        });
    } catch (error) {
        console.error(`Error al enviar el mensaje de plantilla para ${companyId} a ${formattedPhone}: `, error);
        res.status(500).json({
            message: "Error al enviar el mensaje de plantilla",
            error: error.message,
        });
    }
}

// Obtiene el estado y el QR (si es necesario) para un cliente
const getSessionInfo = async (companyId) => {
    console.log(`Solicitando información de sesión para companyId: ${companyId} `);
    if (!clients[companyId] || !clients[companyId].client) {
        console.log(`Cliente para ${companyId} no encontrado.Inicializando uno nuevo.`);
        initializeClient(companyId);
        // Después de inicializar, esperamos un poco a que se genere el QR o se conecte
        await new Promise(resolve => setTimeout(resolve, 1000)); // Espera inicial
    }

    // Esperar a que el cliente esté listo o que haya un QR disponible
    // Añadimos un límite de tiempo para no esperar indefinidamente
    const waitTimeout = 30000; // 30 segundos
    const startTime = Date.now();

    while (true) {
        const elapsed = Date.now() - startTime;
        if (elapsed > waitTimeout) {
            console.error(`getSessionInfo: Timeout esperando por el estado o QR para ${companyId} `);
            return {
                qr: null,
                ws_ready: false,
                message: `Timeout(${waitTimeout / 1000}s) esperando estado para ${companyId}.Intente reiniciar o verificar logs.`,
                error: "Timeout"
            };
        }

        const clientData = clients[companyId];
        if (clientData) {
            if (clientData.whatsappReady) {
                console.log(`getSessionInfo: Cliente ${companyId} está listo.`);
                try {
                    // Opcional: obtener info detallada del cliente si está listo
                    const info = await clientData.client.info;
                    return {
                        qr: null, // Ya no se necesita QR
                        ws_ready: true,
                        message: `Cliente de WhatsApp listo para la compañía ID ${companyId}.Número: ${info.wid.user}.`,
                        info: { // Información útil del cliente conectado
                            id: info.wid._serialized,
                            number: info.wid.user,
                            platform: info.platform,
                            pushname: info.pushname,
                        }
                    };
                } catch (infoError) {
                    console.error(`getSessionInfo: Error obteniendo info del cliente ${companyId}: `, infoError);
                    // Aún si falla obtener info, sabemos que está listo
                    return {
                        qr: null,
                        ws_ready: true,
                        message: `Cliente de WhatsApp listo para la compañía ID ${companyId}, pero hubo un error al obtener la información detallada.`,
                        error: infoError.message
                    };
                }

            } else if (clientData.qrCodeImage) {
                console.log(`getSessionInfo: QR disponible para ${companyId}.`);
                return {
                    qr: clientData.qrCodeImage,
                    ws_ready: false,
                    message: `Escanee el código QR para la compañía ID ${companyId}.`,
                };
            } else if (clientData.error) {
                console.error(`getSessionInfo: Error detectado para ${companyId}.`, clientData.error);
                return {
                    qr: null,
                    ws_ready: false,
                    message: `Error en el cliente para ${companyId}: ${clientData.error.message} `,
                    error: clientData.error.message
                };
            }
            // If clientData exists but neither ready nor QR nor error, continue waiting
        } else {
            // This case should ideally not happen if initializeClient was called,
            // but as a safeguard:
            console.warn(`getSessionInfo: Client object disappeared for ${companyId} while waiting.`);
            return {
                qr: null,
                ws_ready: false,
                message: `Estado desconocido para la compañía ID ${companyId}. El objeto cliente no fue encontrado.`,
                error: "Client object missing"
            };
        }

        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 500)); // Esperar 500ms
    }
};

// Obtiene una lista del estado de todos los clientes registrados
const getConnectedClients = async (req, res) => {
    try {
        const allClientsInfo = Object.keys(clients).map(companyId => {
            const clientData = clients[companyId];
            // Intenta obtener el estado actual del cliente si la instancia existe
            const clientState = clientData && clientData.client ? clientData.client.state : 'UNINITIALIZED';
            const errorMessage = clientData && clientData.error ? clientData.error.message : null;

            return {
                company_id: companyId,
                whatsapp_ready: clientData ? clientData.whatsappReady : false,
                status_detail: clientData ? (clientData.whatsappReady ? 'READY' : (clientData.qrCodeImage ? 'REQUIRES_QR' : (errorMessage ? 'ERROR' : (clientState === 'UNINITIALIZED' ? 'STARTING' : clientState)))) : 'NOT_REGISTERED',
                error_message: errorMessage,
                actions: companyId, // Placeholder for actions in frontend
                // Puedes agregar más información relevante si lo deseas
            };
        });

        res.status(200).json(allClientsInfo);
    } catch (error) {
        console.error("Error al obtener la lista de clientes (conectados y desconectados):", error);
        res.status(500).json({
            message: "Error al obtener la lista de clientes (conectados y desconectados)",
            error: error.message,
        });
    }
};

// Obtiene los chats con el último mensaje para un cliente específico
const getChatsByCompanyId = async (req, res) => {
    const { companyId } = req.params;
    console.log(`Intentando obtener chats para companyId: ${companyId} `);

    if (!clients[companyId] || !clients[companyId].whatsappReady) {
        console.warn(`Intento de obtener chats para ${companyId}, pero el cliente no está listo.`);
        return res.status(400).json({
            message: `El cliente de WhatsApp para la compañía ${companyId} no está listo o no está conectado.`,
        });
    }

    try {
        // Limita el número total de chats para evitar sobrecarga, si es necesario
        const chats = await clients[companyId].client.getChats();

        // Filtra las historias de estado y, opcionalmente, grupos si solo quieres chats individuales
        const filteredChats = chats.filter(chat => !chat.isStatus /* && !chat.isGroup */);

        const chatList = await Promise.all(filteredChats.map(async chat => {
            let lastMessageBody = null;
            try {
                // Intenta obtener el último mensaje
                const messages = await chat.fetchMessages({ limit: 1 });
                lastMessageBody = messages.length > 0 ? messages[0].body : null;
            } catch (msgError) {
                console.warn(`Error fetching last message for chat ${chat.id._serialized} of ${companyId}: `, msgError);
                lastMessageBody = "Error al cargar mensaje.";
            }


            return {
                id: chat.id._serialized,
                name: chat.name,
                isGroup: chat.isGroup,
                unreadCount: chat.unreadCount,
                lastMessage: lastMessageBody,
                timestamp: chat.lastMessage?._data?.t * 1000 || null, // Timestamp en milisegundos
                // Puedes incluir más información del chat si es necesario
                // contact: await chat.getContact() // Costoso si se hace para todos los chats
            };
        }));

        // Opcional: Ordenar chats por fecha del último mensaje
        chatList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));


        res.status(200).json(chatList);
    } catch (error) {
        console.error(`Error al obtener los chats para la compañía ${companyId}: `, error);
        res.status(500).json({
            message: `Error al obtener los chats para la compañía ${companyId} `,
            error: error.message,
        });
    }
};

// Reinicia el cliente de WhatsApp para una compañía específica
const restartClientByCompanyId = async (req, res) => {
    const { companyId } = req.params;
    console.log(`Solicitud de reinicio para companyId: ${companyId} `);

    // Verificamos si existe la entrada para este companyId
    if (!clients[companyId]) {
        console.log(`No se encontró entrada de cliente para ${companyId}. Inicializando una nueva.`);
        initializeClient(companyId);
        return res.status(200).json({
            message: `No se encontró registro de un cliente para la compañía ${companyId}, iniciando un nuevo proceso.`,
        });
    }

    try {
        console.log(`Intentando destruir cliente existente para ${companyId}.`);

        // 1. Destruir la instancia actual del cliente si existe
        if (clients[companyId].client) {
            // destroy() es asíncrono y limpia recursos de puppeteer
            await clients[companyId].client.destroy();
            console.log(`Cliente destruido para ${companyId}.`);
        } else {
            console.log(`No había instancia de cliente activa para destruir para ${companyId}.`);
        }

        // 2. Limpiar el estado en memoria para este companyId
        clients[companyId].whatsappReady = false;
        clients[companyId].qrCodeImage = null;
        delete clients[companyId].client; // Eliminar la referencia al cliente destruido
        delete clients[companyId].error; // Limpiar cualquier error previo

        // 3. Inicializar una nueva instancia del cliente
        // La función initializeClient se encargará de crear la nueva instancia,
        // configurar los listeners y llamar a client.initialize().
        initializeClient(companyId);

        console.log(`Proceso de reinicio iniciado para ${companyId}.`);

        // Respondemos inmediatamente indicando que el proceso de reinicio ha comenzado.
        // El estado final (listo o requiriendo QR) se reflejará en getSessionInfo o getConnectedClients.
        res.status(200).json({
            message: `Se ha iniciado el proceso de reinicio del servicio de WhatsApp para la compañía ${companyId}. Por favor, espere a que el cliente se conecte o se muestre el nuevo código QR.`,
        });

    } catch (error) {
        console.error(
            `Error general durante el proceso de reinicio para ${companyId}: `,
            error
        );
        res.status(500).json({
            message: `Error al reiniciar el servicio de WhatsApp para la compañía ${companyId} `,
            error: error.message,
        });
    }
};

// --- NUEVA FUNCIÓN PARA ENVIAR MENSAJE DIRECTO ---
const sendDirectMessage = async (req, res) => {
    const { companyId } = req.params; // ID_EMPRESA viene de la URL
    const { phone, message } = req.body; // Teléfono y mensaje vienen del cuerpo de la petición

    if (!clients[companyId] || !clients[companyId].whatsappReady) {
        return res.status(503).json({ // 503 Service Unavailable
            success: false,
            message: `El cliente de WhatsApp para la compañía ${companyId} no está listo o no está conectado.`,
        });
    }

    if (!phone || !message) {
        return res.status(400).json({
            success: false,
            message: "Faltan parámetros obligatorios: 'phone' y 'message'.",
        });
    }

    const formattedPhone = `${phone}@c.us`;

    try {
        console.log(`Intentando enviar mensaje a ${formattedPhone} para ${companyId} (Fire and Forget).`);

        // NO USAMOS AWAIT para evitar el bug de la librería que ocurre después de enviar.
        clients[companyId].client.sendMessage(formattedPhone, message);

        // Asumimos éxito y respondemos inmediatamente.
        console.log(`Mensaje para ${formattedPhone} despachado. Respondiendo con éxito.`);
        res.status(200).json({
            success: true,
            message: `Mensaje para el número ${phone} ha sido despachado exitosamente.`,
        });

    } catch (error) {
        // Este bloque ahora solo capturará errores síncronos inmediatos, no el fallo de la promesa.
        console.error(`Error síncrono al intentar despachar el mensaje para ${companyId} a ${formattedPhone}:`, error);
        res.status(500).json({
            success: false,
            message: "Error interno al intentar despachar el mensaje.",
            error: error.message,
        });
    }
};

module.exports = {
    getSessionInfo,
    initializeClient, // Mantenemos exportada por si acaso, aunque initializeAllClientsFromSessions la usa internamente
    initializeAllClientsFromSessions, // Exportar la nueva función
    showQRCode,
    showQRCodeBasic,
    sendMessage,
    sendMessageCustom,
    sendTemplateMessage,
    sendDirectMessage,
    getConnectedClients,
    getChatsByCompanyId,
    restartClientByCompanyId,
    disconnectClientByCompanyId,
};
