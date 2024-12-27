# Usa una imagen base de Node.js (elige la versión que usas localmente)
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

# Crea un directorio para la aplicación dentro del contenedor
WORKDIR /app

# Copia los archivos package.json y package-lock.json (si lo tienes)
COPY package*.json ./

# Instalar programas

RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    ca-certificates \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    fonts-liberation \
    libappindicator1 \
    libgbm-dev \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \ 
    && echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list
RUN apt-get update && apt-get -y install google-chrome-stable

RUN curl -sL https://deb.nodesource.com/setup_23.x | bash -
RUN apt-get install -y nodejs
COPY package*.json ./

# Instala las dependencias
RUN npm install

# Copia el resto del código de la aplicación
COPY . .

# Expone el puerto que usa tu aplicación (ejemplo: 3000)
EXPOSE 3000

# Comando para iniciar la aplicación
CMD [ "npm", "start" ]