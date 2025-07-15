const fs = require("fs")
const path = require("path")

const loadTemplates = () => {
    const templatesDir = path.join(__dirname, "templates")
    const templates = {}

    fs.readdirSync(templatesDir).forEach((file) => {
        const templatePath = path.join(templatesDir, file)
        const templateName = path.basename(file, path.extname(file))

        // Utilizar require para cargar el módulo de JavaScript
        templates[templateName] = require(templatePath)
    })

    return templates
}

module.exports = loadTemplates
