
const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const send = (res, status, data) => res.status(status).json(data);

function getBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function getPath(req) {
  const url = new URL(req.url, "https://local.invalid");
  const path = url.searchParams.get("path");
  return "/" + String(path || "").replace(/^\/+|\/+$/g, "");
}

async function getUser(req) {
  const authorization = req.headers.authorization || "";
  const authToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : req.headers["x-auth-token"];

  if (!authToken) return null;

  const result = await pool.query(
    `SELECT u.id, u.shop_id, u.email, u.email_verified,
            u.full_name, u.role, u.token,
            s.name AS shop_name
     FROM users u
     JOIN shops s ON s.id = u.shop_id
     WHERE u.token = $1
     LIMIT 1`,
    [authToken]
  );

  return result.rows[0] || null;
}

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activation_requests (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL
        REFERENCES shops(id) ON DELETE CASCADE,
      user_id INTEGER
        REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      admin_note TEXT NOT NULL DEFAULT '',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS activation_requests_status_idx
      ON activation_requests(status, requested_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS activation_one_pending_per_shop
      ON activation_requests(shop_id)
      WHERE status = 'pending';
  `);
}

function checkAdmin(req) {
  const secret = process.env.DOKANYAAR_ADMIN_KEY;
  const supplied = req.headers["x-admin-key"];

  return Boolean(secret && supplied && supplied === secret);
}

async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  const path = getPath(req);
  const method = (req.method || "GET").toUpperCase();

  await setup();

  // مدیر: دیدن درخواست‌های فعال‌سازی
  if (
    method === "GET" &&
    path === "/admin/activation-requests"
  ) {
    if (!checkAdmin(req)) {
      return send(res, 403, {
        success: false,
        error: "کلید مدیر نادرست است.",
      });
    }

    const result = await pool.query(`
      SELECT ar.id, ar.shop_id, ar.user_id, ar.status,
             ar.admin_note, ar.requested_at, ar.reviewed_at,
             s.name AS shop_name, s.owner_name,
             u.email, u.full_name
      FROM activation_requests ar
      LEFT JOIN shops s ON s.id = ar.shop_id
      LEFT JOIN users u ON u.id = ar.user_id
      ORDER BY
        CASE WHEN ar.status = 'pending' THEN 0 ELSE 1 END,
        ar.requested_at DESC
      LIMIT 200
    `);

    return send(res, 200, {
      success: true,
      requests: result.rows,
    });
  }

  // مدیر: تأیید یا رد درخواست
  if (
    method === "POST" &&
    path === "/admin/review-activation"
  ) {
    if (!checkAdmin(req)) {
      return send(res, 403, {
        success: false,
        error: "کلید مدیر نادرست است.",
      });
    }

    const body = getBody(req);
    const requestId = Number(body.request_id);
    const decision = String(body.decision || "").trim();
    const reason = String(body.reason || "").trim().slice(0, 1000);

    if (!Number.isInteger(requestId) || requestId < 1) {
      return send(res, 400, {
        success: false,
        error: "شماره درخواست معتبر نیست.",
      });
    }

    if (!["approve", "reject"].includes(decision)) {
      return send(res, 400, {
        success: false,
        error: "تصمیم باید approve یا reject باشد.",
      });
    }

    if (decision === "reject" && !reason) {
      return send(res, 400, {
        success: false,
        error: "برای رد درخواست، نوشتن دلیل الزامی است.",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const found = await client.query(
        `SELECT * FROM activation_requests
         WHERE id = $1 FOR UPDATE`,
        [requestId]
      );

      if (!found.rowCount) {
        await client.query("ROLLBACK");
        return send(res, 404, {
          success: false,
          error: "درخواست پیدا نشد.",
        });
      }

      const request = found.rows[0];

      if (request.status !== "pending") {
        await client.query("ROLLBACK");
        return send(res, 409, {
          success: false,
          error: "این درخواست قبلاً بررسی شده است.",
        });
      }

      if (decision === "approve") {
        await client.query(
          `INSERT INTO subscriptions
            (shop_id, plan, status, amount_usdt, starts_at, expires_at)
           VALUES ($1, 'permanent', 'active', 0, NOW(), NULL)
           ON CONFLICT (shop_id) DO UPDATE SET
             plan = 'permanent',
             status = 'active',
             amount_usdt = 0,
             starts_at = COALESCE(
               subscriptions.starts_at, NOW()
             ),
             expires_at = NULL`,
          [request.shop_id]
        );

        await client.query(
          `UPDATE activation_requests
           SET status = 'approved',
               admin_note = $1,
               reviewed_at = NOW()
           WHERE id = $2`,
          [reason || "فعال‌سازی رایگان تأیید شد.", requestId]
        );
      } else {
        await client.query(
          `UPDATE activation_requests
           SET status = 'rejected',
               admin_note = $1,
               reviewed_at = NOW()
           WHERE id = $2`,
          [reason, requestId]
        );
      }

      await client.query("COMMIT");

      return send(res, 200, {
        success: true,
        status: decision === "approve" ? "approved" : "rejected",
        message:
          decision === "approve"
            ? "فعال‌سازی دایمی رایگان تأیید شد."
            : "درخواست رد شد و دلیل ثبت گردید.",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // از این‌جا به بعد، مشتری باید وارد حساب خود شده باشد.
  const user = await getUser(req);

  if (!user) {
    return send(res, 401, {
      success: false,
      error: "ابتدا وارد حساب دوکان‌یار شوید.",
    });
  }

  if (user.email && !user.email_verified) {
    return send(res, 403, {
      success: false,
      error: "ابتدا ایمیل خود را تأیید کنید.",
    });
  }

  // مشتری: ثبت درخواست فعال‌سازی رایگان
  if (method === "POST" && path === "/activation-request") {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        "SELECT id FROM shops WHERE id = $1 FOR UPDATE",
        [user.shop_id]
      );

      const subscription = await client.query(
        "SELECT status FROM subscriptions WHERE shop_id = $1",
        [user.shop_id]
      );

      if (
        subscription.rowCount &&
        subscription.rows[0].status === "active"
      ) {
        await client.query("COMMIT");
        return send(res, 200, {
          success: true,
          status: "active",
          message: "حساب شما قبلاً فعال شده است.",
        });
      }

      const pending = await client.query(
        `SELECT id, status, requested_at
         FROM activation_requests
         WHERE shop_id = $1 AND status = 'pending'
         LIMIT 1`,
        [user.shop_id]
      );

      if (pending.rowCount) {
        await client.query("COMMIT");
        return send(res, 200, {
          success: true,
          status: "pending",
          request: pending.rows[0],
          message: "درخواست شما قبلاً ثبت شده و منتظر بررسی مدیر است.",
        });
      }

      const inserted = await client.query(
        `INSERT INTO activation_requests (shop_id, user_id)
         VALUES ($1, $2)
         RETURNING id, status, requested_at`,
        [user.shop_id, user.id]
      );

      await client.query("COMMIT");

      return send(res, 201, {
        success: true,
        status: "pending",
        request: inserted.rows[0],
        message: "درخواست فعال‌سازی رایگان ثبت شد.",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // مشتری: دیدن وضعیت درخواست
  if (method === "GET" && path === "/activation-status") {
    const result = await pool.query(
      `SELECT id, status, admin_note, requested_at, reviewed_at
       FROM activation_requests
       WHERE shop_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [user.shop_id]
    );

    const subscription = await pool.query(
      `SELECT plan, status, amount_usdt, starts_at, expires_at
       FROM subscriptions
       WHERE shop_id = $1
       LIMIT 1`,
      [user.shop_id]
    );

    return send(res, 200, {
      success: true,
      request: result.rows[0] || null,
      subscription: subscription.rows[0] || null,
    });
  }

  return send(res, 404, {
    success: false,
    error: "Endpoint not found",
    path,
  });
}

module.exports = async (req, res) => {
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Auth-Token, X-Admin-Key"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  try {
    return await handler(req, res);
  } catch (error) {
    console.error("DokanYar activation error:", error);
    return send(res, 500, {
      success: false,
      error: "خطای سرور در سیستم فعال‌سازی. لاگ Vercel را بررسی کنید.",
    });
  }
};
