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

router.get("/noqr", (req, res) => {
    res.sendFile("nocode.html", { root: "./public" })
})

router.get("/qr", whatsappController.showQRCode)

router.post("/send-message", whatsappController.sendMessage)
// router.post("/login", authenticateToken)
// router.post("/login", authenticateToken)

// router.get("/qr", authenticateToken, whatsappController.showQRCode)
// router.get('/qr', authenticateToken, authenticateToken);

// Ruta para enviar un mensaje

module.exports = router
