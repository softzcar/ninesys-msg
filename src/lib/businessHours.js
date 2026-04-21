/**
 * businessHours.js
 *
 * Helpers puros (sin I/O) para razonar sobre el horario laboral de una
 * empresa (Fase D.3).
 *
 * Formato de `hours` (el que devuelve ninesys-api /internal/business-hours):
 *   {
 *     horaInicioManana: 8.5,   // decimal: 8.5 = 08:30
 *     horaFinManana:    12,
 *     horaInicioTarde:  13,
 *     horaFinTarde:     17.5,
 *     diasLaborales:    [1,2,3,4,5]   // 1=Lun .. 7=Dom
 *   }
 *
 * Cualquier tramo con valor null/'' se ignora (empresa que no tiene turno
 * tarde, por ejemplo).
 *
 * ⚠ Zona horaria: se usa la zona horaria del servidor (Date#getHours y
 * Date#getDay). Cobertura razonable porque ninesys-api y msg_ninesys se
 * despliegan juntos y sus relojes están alineados. Si algún día se
 * despliegan en zonas distintas, habrá que pasar un offset explícito.
 *
 * ⚠ DST: la suma avanza en saltos de 24h exactos. En países sin horario de
 * verano (Venezuela/Colombia) es correcto. En países con DST puede fallar
 * por ±1h dos veces al año — irrelevante para nuestro umbral de 20 min.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Devuelve el día de la semana 1..7 (lun..dom) para un Date.
 * JS por default es 0=Dom..6=Sáb, por eso convertimos.
 */
function dayOfWeek1to7(date) {
    const js = date.getDay();
    return js === 0 ? 7 : js;
}

/**
 * Hora local del día como decimal: 14:30 → 14.5
 */
function decimalHourOf(date) {
    return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/**
 * Devuelve los tramos laborales válidos del día como array de pares
 * [startDecimal, endDecimal]. Filtra los que tengan null/'' y los
 * invertidos (start >= end).
 */
function validWindows(hours) {
    if (!hours || typeof hours !== 'object') return [];
    const candidates = [
        [hours.horaInicioManana, hours.horaFinManana],
        [hours.horaInicioTarde, hours.horaFinTarde],
    ];
    const out = [];
    for (const [s, e] of candidates) {
        if (s === null || s === undefined || s === '') continue;
        if (e === null || e === undefined || e === '') continue;
        const sn = Number(s);
        const en = Number(e);
        if (!Number.isFinite(sn) || !Number.isFinite(en)) continue;
        if (sn >= en) continue;
        out.push([sn, en]);
    }
    return out;
}

/**
 * Devuelve el Set con los días laborales normalizados a 1..7.
 */
function workDaysSet(hours) {
    if (!hours || !Array.isArray(hours.diasLaborales)) return new Set();
    const s = new Set();
    for (const raw of hours.diasLaborales) {
        const n = Number(raw);
        if (!Number.isInteger(n)) continue;
        // Normalizar: si viene 0 (convención 0=Dom..6=Sáb), mapear a 7.
        const normalized = n === 0 ? 7 : n;
        if (normalized >= 1 && normalized <= 7) s.add(normalized);
    }
    return s;
}

/**
 * ¿Estamos dentro del horario laboral de la empresa en la fecha dada?
 * Si `hours` es falsy o inválido, devuelve false (conservador).
 */
function isWithinBusinessHours(date, hours) {
    if (!(date instanceof Date)) date = new Date(date);
    if (isNaN(date.getTime())) return false;
    const days = workDaysSet(hours);
    if (!days.has(dayOfWeek1to7(date))) return false;
    const h = decimalHourOf(date);
    for (const [s, e] of validWindows(hours)) {
        if (h >= s && h < e) return true;
    }
    return false;
}

/**
 * Devuelve una Date con hora local 00:00:00.000 del mismo día que ts.
 */
function localMidnight(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * Suma los minutos que transcurrieron entre `since` y `now` y que caen
 * dentro de un tramo laboral de un día laboral.
 *
 * @param {number|Date} since  - instante de inicio
 * @param {number|Date} now    - instante actual
 * @param {object} hours       - objeto horario_laboral
 * @returns {number} minutos hábiles (puede ser fraccionario)
 */
function minutesElapsedBusiness(since, now, hours) {
    const sinceMs = since instanceof Date ? since.getTime() : Number(since);
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) return 0;
    if (sinceMs >= nowMs) return 0;

    const days = workDaysSet(hours);
    if (!days.size) return 0;
    const windows = validWindows(hours);
    if (!windows.length) return 0;

    let total = 0;
    let cursor = localMidnight(sinceMs).getTime();
    const lastMidnight = localMidnight(nowMs).getTime();

    while (cursor <= lastMidnight) {
        const dayDate = new Date(cursor);
        if (days.has(dayOfWeek1to7(dayDate))) {
            for (const [sH, eH] of windows) {
                const winStart = cursor + Math.round(sH * MS_PER_HOUR);
                const winEnd = cursor + Math.round(eH * MS_PER_HOUR);
                const overlapStart = Math.max(winStart, sinceMs);
                const overlapEnd = Math.min(winEnd, nowMs);
                if (overlapEnd > overlapStart) {
                    total += (overlapEnd - overlapStart) / 60000;
                }
            }
        }
        cursor += MS_PER_DAY;
    }
    return total;
}

module.exports = {
    isWithinBusinessHours,
    minutesElapsedBusiness,
    // Expuestos para tests
    _internal: {
        dayOfWeek1to7,
        decimalHourOf,
        validWindows,
        workDaysSet,
    },
};
