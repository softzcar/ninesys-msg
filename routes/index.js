const express = require("express")
const router = express.Router()
// const authController = require("../controllers/authController")
const whatsappController = require("../controllers/whatsappController")
const authenticateToken = require("../middleware/authenticateToken")

router.get("/", (req, res) => {
    // res.json({ name: 'NTMSG API', version: '1.0.0', login: loginUrl });
    res.sendFile("login.html", { root: "./public" })
})

router.get("/send", (req, res) => {
    res.sendFile("send.html", { root: "./public" })
})

// Se muestra en luagr del codigo cuando aún no se han proporcionado credebciales válidas.
router.get("/noqr", (req, res) => {
    res.sendFile("nocode.html", { root: "./public" })
})

router.get("/qr", whatsappController.showQRCode)

// Ruta para enviar un mensaje desde un formulario local
router.post("/send-message", whatsappController.sendMessage)

/**
 * Ruta para enviar mensajes desde la api externa
 * los datos necesarios par el evío de el mensaje son los mismos que los de el formualrio local
 * - phone
 * - name
 * - message
 */
app.post("/send-message-external", async (req, res) => {
    const { phone, name, message } = req.body
    // Aquí va el código para enviar el mensaje utilizando la API
    try {
        const response = await fetch(
            `${process.env.APP_URL}${process.env.PORT}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.JWT_SECRET}`,
                },
                body: JSON.stringify({ phone, name, message }),
            }
        )
        const data = await response.json()
        if (response.ok) {
            res.json({ message: data.message || "Mensaje enviado con éxito" })
        } else {
            res.status(response.status).json({
                error: data.error || "Error al enviar el mensaje",
            })
        }
    } catch (error) {
        res.status(500).json({ error: "Error interno del servidor" })
    }
})
// Ruta para enviar un mensaje recibiendo datos desde una llaada externa:

// router.post("/login", authenticateToken)
// router.post("/login", authenticateToken)

// router.get("/qr", authenticateToken, whatsappController.showQRCode)
// router.get('/qr', authenticateToken, authenticateToken);

module.exports = router
