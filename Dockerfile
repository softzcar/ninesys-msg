# Instala las dependencias del sistema necesarias para Puppeteer
RUN apt-get update && apt-get install -y \
[root@ninesys public_html]# cat Dockerfile 
# Usa una imagen base oficial de Node.js
FROM node:18

# Instala las dependencias del sistema necesarias para Puppeteer
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-noto-color-emoji \
    gnupg \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgbm-dev \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango1.0-0 \
    libpangocairo-1.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxi6 \
    libxrandr2 \
    wget \
    xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Configura el directorio de trabajo
WORKDIR /app

# Copia los archivos de dependencias primero
COPY package*.json ./

# Instala las dependencias de Node.js
RUN npm install

# Copia el resto de los archivos de la aplicación
COPY . .

# Establece la variable de entorno para deshabilitar la descarga de Chromium en Puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Instala manualmente Chromium (opcional si Puppeteer no lo incluye)
RUN npm install puppeteer

# Expone el puerto de la aplicación
EXPOSE 3200

# Comando para iniciar la aplicación
CMD ["node", "--no-sandbox", "app.js"]
