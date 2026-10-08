const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING,
  ssl: { rejectUnauthorized: false }
});

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res.json(data);
}

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;

  try {
    return JSON.parse(req.body);
  } catch (e) {
    return {};
  }
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function verificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/* =========================
   RESEND
========================= */

async function sendVerificationEmail(email, code) {

  var apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY در Vercel پیدا نشد. به Environment Variables برو."
    );
  }

  /*
    اگر RESEND_FROM_EMAIL تنظیم نشده باشد،
    از فرستنده تست Resend استفاده می‌کنیم.
  */
  var from =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

  var response;

  try {

    response = await fetch("https://api.resend.com/emails", {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },

      body: JSON.stringify({
        from: "Dokanyaar <" + from + ">",
        to: [email],
        subject: "کد تأیید دوکان‌یار",
        html:
          "<div style=\"font-family:Arial,Tahoma,sans-serif;direction:rtl;text-align:right\">" +
          "<h2>دوکان‌یار</h2>" +
          "<p>کد تأیید ایمیل شما:</p>" +
          "<div style=\"font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f3f4f6;border-radius:12px\">" +
          code +
          "</div>" +
          "<p>این کد برای مدت محدود معتبر است.</p>" +
          "<p>اگر شما درخواست ثبت‌نام نکرده‌اید، این ایمیل را نادیده بگیرید.</p>" +
          "</div>"
      })
    });

  } catch (networkError) {

    throw new Error(
      "ارتباط با سرویس ایمیل Resend برقرار نشد: " +
      networkError.message
    );

  }

  var text = await response.text();

  var result;

  try {
    result = JSON.parse(text);
  } catch (e) {
    result = {
      raw: text
    };
  }

  /*
    این قسمت مهم است:
    خطای واقعی Resend را برمی‌گرداند.
  */

  if (!response.ok) {

    var resendMessage =
      result && result.message
        ? result.message
        : result && result.error
        ? result.error
        : result && result.name
        ? result.name
        : text;

    throw new Error(
      "Resend خطا داد: " +
      resendMessage +
      " | HTTP " +
      response.status
    );
  }

  if (!result || !result.id) {

    throw new Error(
      "Resend پاسخ موفق اما بدون شناسه ایمیل برگرداند: " +
      JSON.stringify(result)
    );
  }

  return {
    id: result.id,
    from: from,
    to: email
  };
}


/* =========================
   DATABASE SETUP
========================= */

async function setupDatabase() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT DEFAULT '',
      username TEXT DEFAULT '',
      email TEXT DEFAULT '',
      password TEXT DEFAULT '',
      role TEXT DEFAULT 'owner',
      token TEXT,
      email_verified BOOLEAN DEFAULT FALSE,
      verification_code TEXT,
      verification_expires TIMESTAMP,
      verification_attempts INTEGER DEFAULT 0,
      last_verification_sent TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brand TEXT DEFAULT '',
      model TEXT DEFAULT '',
      buy_price NUMERIC(18,2) DEFAULT 0,
      sell_price NUMERIC(18,2) DEFAULT 0,
      quantity NUMERIC(18,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL,
      quantity NUMERIC(18,2) DEFAULT 0,
      unit_price NUMERIC(18,2) DEFAULT 0,
      total NUMERIC(18,2) DEFAULT 0,
      buy_cost NUMERIC(18,2) DEFAULT 0,
      profit NUMERIC(18,2) DEFAULT 0,
      currency TEXT DEFAULT 'AFN',
      currency_rate NUMERIC(18,6) DEFAULT 1,
      base_unit_price NUMERIC(18,2) DEFAULT 0,
      base_total NUMERIC(18,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  var alterations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'owner'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_verification_sent TIMESTAMP`,

    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'AFN'`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency_rate NUMERIC(18,6) DEFAULT 1`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS base_total NUMERIC(18,2) DEFAULT 0`
  ];

  for (var i = 0; i < alterations.length; i++) {
    await pool.query(alterations[i]);
  }

  await pool.query(`
    UPDATE transactions
    SET
      currency = COALESCE(currency, 'AFN'),
      currency_rate = COALESCE(currency_rate, 1),
      base_unit_price = CASE
        WHEN COALESCE(base_unit_price,0) = 0 THEN unit_price
        ELSE base_unit_price
      END,
      base_total = CASE
        WHEN COALESCE(base_total,0) = 0 THEN total
        ELSE base_total
      END
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email
    ON users(email)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_token
    ON users(token)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_shop
    ON products(shop_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_shop
    ON transactions(shop_id)
  `);

  return true;
}


/* =========================
   AUTH
========================= */

async function getAuthUser(req) {

  var auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  var token = auth.substring(7).trim();

  if (!token) {
    return null;
  }

  var result = await pool.query(
    `SELECT * FROM users WHERE token=$1 LIMIT 1`,
    [token]
  );

  if (!result.rows.length) {
    return null;
  }

  return result.rows[0];
}

function requireUser(req, res) {
  return getAuthUser(req);
}


/* =========================
   ROUTER
========================= */

module.exports = async function handler(req, res) {

  if (req.method === "OPTIONS") {
    return json(res, 200, { success: true });
  }

  var path = req.url.split("?")[0];

  path = path.replace(/^\/api/, "");

  if (path === "") {
    path = "/";
  }

  try {

    await setupDatabase();

    /* =========================
       ROOT
    ========================= */

    if (path === "/" && req.method === "GET") {

      return json(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: true,
        email_verification: true,
        resend_configured: !!process.env.RESEND_API_KEY
      });

    }


    /* =========================
       SETUP
    ========================= */

    if (path === "/setup" && req.method === "GET") {

      return json(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دیتابیس و ایمیل آماده است.",
        database: true,
        email_verification: true,
        resend_configured: !!process.env.RESEND_API_KEY
      });

    }


    /* =========================
       REGISTER
    ========================= */

    if (path === "/register" && req.method === "POST") {

      var b = body(req);

      var shopName = String(
        b.shop_name ||
        b.shopName ||
        ""
      ).trim();

      var name = String(
        b.owner_name ||
        b.name ||
        b.username ||
        ""
      ).trim();

      var email = normalizeEmail(b.email);
      var password = String(b.password || "");

      if (!shopName || !name || !email || !password) {
        return json(res, 400, {
          success: false,
          error: "نام دوکان، نام کاربر، ایمیل و رمز عبور الزامی است."
        });
      }

      if (password.length < 6) {
        return json(res, 400, {
          success: false,
          error: "رمز عبور باید حداقل ۶ حرف باشد."
        });
      }

      var old = await pool.query(
        `SELECT id FROM users WHERE email=$1 LIMIT 1`,
        [email]
      );

      if (old.rows.length) {

        return json(res, 400, {
          success: false,
          error: "این ایمیل قبلاً ثبت شده است."
        });

      }

      var shopResult = await pool.query(
        `INSERT INTO shops(name)
         VALUES($1)
         RETURNING id,name`,
        [shopName]
      );

      var shop = shopResult.rows[0];

      var code = verificationCode();

      var expires = new Date(
        Date.now() + 10 * 60 * 1000
      );

      var userResult = await pool.query(
        `INSERT INTO users(
          shop_id,
          name,
          username,
          email,
          password,
          role,
          email_verified,
          verification_code,
          verification_expires,
          verification_attempts,
          last_verification_sent
        )
        VALUES($1,$2,$2,$3,$4,'owner',FALSE,$5,$6,0,NOW())
        RETURNING id,email`,
        [
          shop.id,
          name,
          email,
          hashPassword(password),
          code,
          expires
        ]
      );

      try {

        var emailResult =
          await sendVerificationEmail(email, code);

        return json(res, 200, {
          success: true,
          message: "ثبت‌نام انجام شد. کد تأیید ارسال شد.",
          email: email,
          email_sent: true,
          email_id: emailResult.id
        });

      } catch (emailError) {

        /*
          اگر ارسال ایمیل شکست خورد،
          کاربر را پاک نمی‌کنیم؛
          خطای دقیق Resend را برمی‌گردانیم.
        */

        await pool.query(
          `DELETE FROM users WHERE id=$1`,
          [userResult.rows[0].id]
        );

        await pool.query(
          `DELETE FROM shops WHERE id=$1`,
          [shop.id]
        );

        return json(res, 502, {
          success: false,
          error: emailError.message,
          email_sent: false,
          hint:
            "خطای بالا از Resend است. کلید API را در Vercel بررسی کنید و در صورت نیاز فرستنده ایمیل را تنظیم کنید."
        });

      }

    }


    /* =========================
       VERIFY EMAIL
    ========================= */

    if (
      (path === "/verify-email" || path === "/verify") &&
      req.method === "POST"
    ) {

      var vb = body(req);

      var vemail = normalizeEmail(vb.email);
      var vcode = String(vb.code || "").trim();

      if (!vemail || !vcode) {
        return json(res, 400, {
          success: false,
          error: "ایمیل و کد الزامی است."
        });
      }

      var vu = await pool.query(
        `SELECT * FROM users WHERE email=$1 LIMIT 1`,
        [vemail]
      );

      if (!vu.rows.length) {
        return json(res, 404, {
          success: false,
          error: "کاربر پیدا نشد."
        });
      }

      var user = vu.rows[0];

      if (user.email_verified) {
        return json(res, 200, {
          success: true,
          message: "ایمیل قبلاً تأیید شده است."
        });
      }

      if (
        !user.verification_expires ||
        new Date(user.verification_expires).getTime() <
          Date.now()
      ) {

        return json(res, 400, {
          success: false,
          error: "کد منقضی شده است. کد جدید درخواست کنید."
        });

      }

      if (user.verification_code !== vcode) {

        await pool.query(
          `UPDATE users
           SET verification_attempts =
             COALESCE(verification_attempts,0)+1
           WHERE id=$1`,
          [user.id]
        );

        return json(res, 400, {
          success: false,
          error: "کد تأیید اشتباه است."
        });

      }

      await pool.query(
        `UPDATE users
         SET
           email_verified=TRUE,
           verification_code=NULL,
           verification_expires=NULL
         WHERE id=$1`,
        [user.id]
      );

      return json(res, 200, {
        success: true,
        message: "ایمیل با موفقیت تأیید شد."
      });

    }


    /* =========================
       RESEND CODE
    ========================= */

    if (
      (path === "/resend-code" ||
       path === "/resend-verification") &&
      req.method === "POST"
    ) {

      var rb = body(req);
      var remail = normalizeEmail(rb.email);

      if (!remail) {
        return json(res, 400, {
          success: false,
          error: "ایمیل را وارد کنید."
        });
      }

      var ru = await pool.query(
        `SELECT * FROM users WHERE email=$1 LIMIT 1`,
        [remail]
      );

      if (!ru.rows.length) {
        return json(res, 404, {
          success: false,
          error: "کاربر پیدا نشد."
        });
      }

      var ruser = ru.rows[0];

      if (ruser.email_verified) {
        return json(res, 400, {
          success: false,
          error: "ایمیل قبلاً تأیید شده است."
        });
      }

      var newCode = verificationCode();

      var newExpires = new Date(
        Date.now() + 10 * 60 * 1000
      );

      await pool.query(
        `UPDATE users
         SET
           verification_code=$1,
           verification_expires=$2,
           verification_attempts=0,
           last_verification_sent=NOW()
         WHERE id=$3`,
        [
          newCode,
          newExpires,
          ruser.id
        ]
      );

      try {

        var resendResult =
          await sendVerificationEmail(
            remail,
            newCode
          );

        return json(res, 200, {
          success: true,
          message: "کد جدید ارسال شد.",
          email_sent: true,
          email_id: resendResult.id
        });

      } catch (emailError) {

        return json(res, 502, {
          success: false,
          error: emailError.message,
          email_sent: false
        });

      }

    }


    /* =========================
       LOGIN
    ========================= */

    if (path === "/login" && req.method === "POST") {

      var lb = body(req);

      var lemail = normalizeEmail(lb.email);
      var lpassword = String(lb.password || "");

      var lr = await pool.query(
        `SELECT * FROM users WHERE email=$1 LIMIT 1`,
        [lemail]
      );

      if (!lr.rows.length) {
        return json(res, 401, {
          success: false,
          error: "ایمیل یا رمز عبور اشتباه است."
        });
      }

      var lu = lr.rows[0];

      if (
        lu.password !== hashPassword(lpassword)
      ) {
        return json(res, 401, {
          success: false,
          error: "ایمیل یا رمز عبور اشتباه است."
        });
      }

      if (!lu.email_verified) {
        return json(res, 403, {
          success: false,
          error:
            "ایمیل شما تأیید نشده است. ابتدا کد ۶ رقمی ایمیل را وارد کنید.",
          email_verified: false
        });
      }

      var loginToken = randomToken();

      await pool.query(
        `UPDATE users
         SET token=$1
         WHERE id=$2`,
        [
          loginToken,
          lu.id
        ]
      );

      return json(res, 200, {
        success: true,
        token: loginToken,
        user: {
          id: lu.id,
          shop_id: lu.shop_id,
          name: lu.name,
          username: lu.username,
          email: lu.email,
          role: lu.role,
          email_verified: lu.email_verified
        }
      });

    }


    /* =========================
       LOGOUT
    ========================= */

    if (path === "/logout" && req.method === "POST") {

      var logoutUser = await getAuthUser(req);

      if (logoutUser) {
        await pool.query(
          `UPDATE users SET token=NULL WHERE id=$1`,
          [logoutUser.id]
        );
      }

      return json(res, 200, {
        success: true
      });

    }


    /* =========================
       ME
    ========================= */

    if (path === "/me" && req.method === "GET") {

      var me = await getAuthUser(req);

      if (!me) {
        return json(res, 401, {
          success: false,
          error: "وارد نشده‌اید."
        });
      }

      return json(res, 200, {
        success: true,
        user: {
          id: me.id,
          shop_id: me.shop_id,
          name: me.name,
          username: me.username,
          email: me.email,
          role: me.role,
          email_verified: me.email_verified
        }
      });

    }


    /* =========================
       UNKNOWN
    ========================= */

    return json(res, 404, {
      success: false,
      error: "Endpoint not found",
      path: path
    });

  } catch (error) {

    console.error("DOKANYAAR API ERROR:", error);

    return json(res, 500, {
      success: false,
      error:
        error && error.message
          ? error.message
          : "خطای داخلی سرور"
    });

  }

};