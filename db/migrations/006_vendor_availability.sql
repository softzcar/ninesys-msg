-- 006_vendor_availability.sql
-- Estado de disponibilidad y límites de carga por vendedor (Fase D.2)

CREATE TABLE IF NOT EXISTS wa_vendor_state (
  user_id       INT NOT NULL PRIMARY KEY,
  is_available  TINYINT(1) NOT NULL DEFAULT 1,
  max_active    INT NOT NULL DEFAULT 0,  -- 0 = sin tope
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP 
                ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Nota: Esta tabla vive en la base de datos de cada tenant (empresa).
-- El user_id corresponde al id del empleado en la tabla de la empresa.
