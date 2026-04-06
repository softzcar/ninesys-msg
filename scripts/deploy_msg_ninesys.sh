#!/bin/bash
# ==============================================================================
# SCRIPT DE DESPLIEGUE - msg_ninesys (servicio WhatsApp)
# ==============================================================================
#
# Sincroniza el código del servicio msg_ninesys al VPS de desarrollo
# (Hostinger) en /home/ozcar/msg-ninesys.
#
# - NO usa git en el destino (no es un repo desplegado, es un directorio plano).
# - Usa rsync para sincronizar respetando .gitignore y excluyendo node_modules,
#   .git, .env, sesiones y caches.
# - Reinicia el proceso PM2 `ntmsg-app` tras la sincronización.
#
# Producción (Contabo) está BLOQUEADA. Solo dev (Hostinger) está habilitado.
# ==============================================================================

set -e

DEV_ALIAS="vps-ninesys"
DEV_PATH="/home/ws.nineteengreen.com/public_html"
PM2_NAME="ntmsg-app"

# Resolver directorio del proyecto desde la ubicación de este script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "------------------------------------------------"
echo "  DESPLIEGUE msg_ninesys - PROTEGIDO"
echo "------------------------------------------------"
echo "1) Producción (Contabo) - [BLOQUEADO POR SEGURIDAD]"
echo "2) Desarrollo (Hostinger - $DEV_ALIAS:$DEV_PATH)"
echo "q) Salir"
echo "------------------------------------------------"
echo -n "Opción [1-2]: "
read CHOICE

case "$CHOICE" in
    1)
        echo "❌ Despliegue a producción bloqueado. Solo dev permitido por este script."
        exit 1
        ;;
    2)
        TARGET="DESARROLLO (Hostinger)"
        REMOTE_ALIAS="$DEV_ALIAS"
        REMOTE_PATH="$DEV_PATH"
        ;;
    *)
        echo "Saliendo..."
        exit 0
        ;;
esac

echo
echo ">>> Origen:  $PROJECT_DIR"
echo ">>> Destino: $REMOTE_ALIAS:$REMOTE_PATH"
echo ">>> Branch local: $(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo '(no git)')"
echo ">>> HEAD local:   $(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo '(no git)')"
echo
echo -n "¿Confirmar despliegue? [s/N]: "
read CONFIRM
if [ "$CONFIRM" != "s" ] && [ "$CONFIRM" != "S" ]; then
    echo "Cancelado."
    exit 0
fi

# Asegurar que el directorio remoto existe
ssh "$REMOTE_ALIAS" "mkdir -p '$REMOTE_PATH'"

echo
echo ">>> Paso 1: rsync (excluyendo node_modules, .git, .env, sesiones, caches)..."
rsync -avz --delete \
    --exclude='.git/' \
    --exclude='node_modules/' \
    --exclude='.env' \
    --exclude='.env.local' \
    --exclude='.wwebjs_auth/' \
    --exclude='.wwebjs_cache/' \
    --exclude='session/' \
    --exclude='tmp/' \
    --exclude='logs/' \
    --exclude='*.log' \
    --exclude='.vscode/' \
    --exclude='.DS_Store' \
    "$PROJECT_DIR/" "$REMOTE_ALIAS:$REMOTE_PATH/"

echo
echo ">>> Paso 2: npm install (solo si package.json cambió)..."
ssh "$REMOTE_ALIAS" "cd '$REMOTE_PATH' && \
    if [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null || [ ! -d node_modules ]; then \
        echo '   Instalando dependencias...'; \
        npm install --omit=dev; \
    else \
        echo '   node_modules al día, salto npm install.'; \
    fi"

echo
echo ">>> Paso 3: Reiniciar PM2 ($PM2_NAME)..."
ssh "$REMOTE_ALIAS" "cd '$REMOTE_PATH' && \
    if pm2 describe '$PM2_NAME' > /dev/null 2>&1; then \
        pm2 restart '$PM2_NAME' --update-env; \
    else \
        echo '   Proceso no existe, lo creo con pm2 start...'; \
        pm2 start app.js --name '$PM2_NAME'; \
    fi && \
    pm2 status '$PM2_NAME'"

echo
echo "✅ DESPLIEGUE EN $TARGET COMPLETADO"
