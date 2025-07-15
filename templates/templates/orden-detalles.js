module.exports = (data) => {
    let report = `Hola ${data.first_name},\n\nEstos son los detalles de tu pedido:\n\n`

    // report += JSON.stringify(data)
    const repPorducts = data.data.object.productos.map((product) => {
        // let tmpData = ""
        // return tmpData
        return `- ${product.name}: ${product.cantidad} unidades`
    })
    // report += tmpData += `\nTotal: ${data.orden.pago_total}\n`
    report += repPorducts
    return report
}
