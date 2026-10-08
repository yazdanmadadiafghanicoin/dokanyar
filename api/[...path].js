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

/* =========================
   RESPONSE
========================= */

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  return res.json(data);
}

/* =========================
   BODY
========================= */

function body(req) {
  if (!req.body) return {};

  if (typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(req.body);
  } catch (e) {
    return {};
  }
}

/* =========================
   HELPERS
========================= */

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
  return String(
    Math.floor(100000 + Math.random() * 900000)
  );
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function number(value, fallback) {
  var n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback === undefined ? 0 : fallback;
  }

  return n;
}

function currencyRate(currency, rate) {
  if (currency === "USD") {
    var r = Number(rate);

    if (!Number.isFinite(r) || r <= 0) {
      return 1;
    }

    return r;
  }

  return 1;
}

/* =========================
   RESEND EMAIL
========================= */

async function sendVerificationEmail(email, code) {
  var apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY در Vercel پیدا نشد."
    );
  }

  var from =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

  var response;

  try {
    response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
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
            "<p>این کد تا ۱۰ دقیقه معتبر است.</p>" +
            "<p>اگر شما درخواست ثبت‌نام نکرده‌اید، این ایمیل را نادیده بگیرید.</p>" +
            "</div>"
        })
      }
    );
  } catch (networkError) {
    throw new Error(
      "ارتباط با Resend برقرار نشد: " +
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
      "Resend پاسخ موفق اما بدون شناسه ایمیل برگرداند."
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
  /* SHOPS */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  /* USERS */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT DEFAULT '',
      username TEXT DEFAULT '',
      email TEXT DEFAULT '',
      password TEXT DEFAULT '',
      password_hash TEXT,
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

  /* PRODUCTS */

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

  /* TRANSACTIONS */

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

  /* =========================
     IMPORTANT MIGRATIONS
  ========================= */

  var alterations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT DEFAULT ''`,

    /* مشکل اصلی شما */
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,

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

  /* =========================
     FIX OLD PASSWORD DATA
  ========================= */

  await pool.query(`
    UPDATE users
    SET password_hash = password
    WHERE
      (password_hash IS NULL OR password_hash = '')
      AND password IS NOT NULL
      AND password <> ''
  `);

  await pool.query(`
    UPDATE users
    SET password = password_hash
    WHERE
      (password IS NULL OR password = '')
      AND password_hash IS NOT NULL
      AND password_hash <> ''
  `);

  /* =========================
     TRANSACTION MIGRATION
  ========================= */

  await pool.query(`
    UPDATE transactions
    SET
      currency = COALESCE(currency, 'AFN'),
      currency_rate = COALESCE(currency_rate, 1),
      base_unit_price =
        CASE
          WHEN COALESCE(base_unit_price, 0) = 0
          THEN unit_price
          ELSE base_unit_price
        END,
      base_total =
        CASE
          WHEN COALESCE(base_total, 0) = 0
          THEN total
          ELSE base_total
        END
  `);

  /* INDEXES */

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
  var auth =
    req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  var token =
    auth.substring(7).trim();

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

/* =========================
   HANDLER
========================= */

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 200, {
      success: true
    });
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

    if (
      path === "/" &&
      req.method === "GET"
    ) {
      return json(res, 200, {
        success: true,
        app: "Dokanyaar",
        message:
          "دوکان‌یار API فعال است.",
        database: true,
        email_verification: true,
        resend_configured:
          !!process.env.RESEND_API_KEY
      });
    }

    /* =========================
       SETUP
    ========================= */

    if (
      path === "/setup" &&
      req.method === "GET"
    ) {
      return json(res, 200, {
        success: true,
        app: "Dokanyaar",
        message:
          "دیتابیس و جداول دوکان‌یار آماده است.",
        database: true,
        email_verification: true,
        resend_configured:
          !!process.env.RESEND_API_KEY
      });
    }

    /* =========================
       REGISTER
    ========================= */

    if (
      path === "/register" &&
      req.method === "POST"
    ) {
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

      var email =
        normalizeEmail(b.email);

      var password =
        String(b.password || "");

      if (
        !shopName ||
        !name ||
        !email ||
        !password
      ) {
        return json(res, 400, {
          success: false,
          error:
            "نام دوکان، نام کاربر، ایمیل و رمز عبور الزامی است."
        });
      }

      if (password.length < 6) {
        return json(res, 400, {
          success: false,
          error:
            "رمز عبور باید حداقل ۶ حرف باشد."
        });
      }

      var old = await pool.query(
        `SELECT id FROM users WHERE email=$1 LIMIT 1`,
        [email]
      );

      if (old.rows.length) {
        return json(res, 400, {
          success: false,
          error:
            "این ایمیل قبلاً ثبت شده است."
        });
      }

      var shopResult =
        await pool.query(
          `INSERT INTO shops(name)
           VALUES($1)
           RETURNING id,name`,
          [shopName]
        );

      var shop =
        shopResult.rows[0];

      var hashed =
        hashPassword(password);

      var code =
        verificationCode();

      var expires =
        new Date(
          Date.now() +
            10 * 60 * 1000
        );

      /*
        اینجا مشکل اصلی رفع شده:
        هم password و هم password_hash
        مقدار می‌گیرند.
      */

      var userResult =
        await pool.query(
          `INSERT INTO users(
            shop_id,
            name,
            username,
            email,
            password,
            password_hash,
            role,
            email_verified,
            verification_code,
            verification_expires,
            verification_attempts,
            last_verification_sent
          )
          VALUES(
            $1,$2,$2,$3,$4,$5,
            'owner',
            FALSE,
            $6,$7,0,NOW()
          )
          RETURNING id,email`,
          [
            shop.id,
            name,
            email,
            hashed,
            hashed,
            code,
            expires
          ]
        );

      try {
        var emailResult =
          await sendVerificationEmail(
            email,
            code
          );

        return json(res, 200, {
          success: true,
          message:
            "ثبت‌نام انجام شد. کد تأیید ارسال شد.",
          email: email,
          email_sent: true,
          email_id:
            emailResult.id
        });
      } catch (emailError) {
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
          error:
            emailError.message,
          email_sent: false
        });
      }
    }

    /* =========================
       VERIFY EMAIL
    ========================= */

    if (
      (
        path === "/verify-email" ||
        path === "/verify"
      ) &&
      req.method === "POST"
    ) {
      var vb = body(req);

      var vemail =
        normalizeEmail(vb.email);

      var vcode =
        String(vb.code || "").trim();

      if (!vemail || !vcode) {
        return json(res, 400, {
          success: false,
          error:
            "ایمیل و کد الزامی است."
        });
      }

      var vu = await pool.query(
        `SELECT * FROM users WHERE email=$1 LIMIT 1`,
        [vemail]
      );

      if (!vu.rows.length) {
        return json(res, 404, {
          success: false,
          error:
            "کاربر پیدا نشد."
        });
      }

      var user = vu.rows[0];

      if (user.email_verified) {
        return json(res, 200, {
          success: true,
          message:
            "ایمیل قبلاً تأیید شده است."
        });
      }

      if (
        !user.verification_expires ||
        new Date(
          user.verification_expires
        ).getTime() < Date.now()
      ) {
        return json(res, 400, {
          success: false,
          error:
            "کد منقضی شده است. کد جدید درخواست کنید."
        });
      }

      if (
        user.verification_code !==
        vcode
      ) {
        await pool.query(
          `UPDATE users
           SET verification_attempts =
             COALESCE(verification_attempts,0)+1
           WHERE id=$1`,
          [user.id]
        );

        return json(res, 400, {
          success: false,
          error:
            "کد تأیید اشتباه است."
        });
      }

      await pool.query(
        `UPDATE users
         SET
           email_verified=TRUE,
           verification_code=NULL,
           verification_expires=NULL,
           verification_attempts=0
         WHERE id=$1`,
        [user.id]
      );

      return json(res, 200, {
        success: true,
        message:
          "ایمیل با موفقیت تأیید شد."
      });
    }

    /* =========================
       RESEND CODE
    ========================= */

    if (
      (
        path === "/resend-code" ||
        path === "/resend-verification"
      ) &&
      req.method === "POST"
    ) {
      var rb = body(req);

      var remail =
        normalizeEmail(rb.email);

      if (!remail) {
        return json(res, 400, {
          success: false,
          error:
            "ایمیل را وارد کنید."
        });
      }

      var ru = await pool.query(
        `SELECT * FROM users WHERE email=$1 LIMIT 1`,
        [remail]
      );

      if (!ru.rows.length) {
        return json(res, 404, {
          success: false,
          error:
            "کاربر پیدا نشد."
        });
      }

      var ruser =
        ru.rows[0];

      if (ruser.email_verified) {
        return json(res, 400, {
          success: false,
          error:
            "ایمیل قبلاً تأیید شده است."
        });
      }

      var newCode =
        verificationCode();

      var newExpires =
        new Date(
          Date.now() +
            10 * 60 * 1000
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
          message:
            "کد جدید ارسال شد.",
          email_sent: true,
          email_id:
            resendResult.id
        });
      } catch (emailError) {
        return json(res, 502, {
          success: false,
          error:
            emailError.message,
          email_sent: false
        });
      }
    }

    /* =========================
       LOGIN
    ========================= */

    if (
      path === "/login" &&
      req.method === "POST"
    ) {
      var lb = body(req);

      var lemail =
        normalizeEmail(lb.email);

      var lpassword =
        String(lb.password || "");

      var lr = await pool.query(
        `SELECT * FROM users WHERE email=$1 LIMIT 1`,
        [lemail]
      );

      if (!lr.rows.length) {
        return json(res, 401, {
          success: false,
          error:
            "ایمیل یا رمز عبور اشتباه است."
        });
      }

      var lu =
        lr.rows[0];

      var hashedLogin =
        hashPassword(lpassword);

      /*
        هم دیتابیس جدید و هم دیتابیس قدیمی
        را قبول می‌کنیم.
      */

      var storedPassword =
        lu.password_hash ||
        lu.password ||
        "";

      if (
        storedPassword !==
        hashedLogin
      ) {
        return json(res, 401, {
          success: false,
          error:
            "ایمیل یا رمز عبور اشتباه است."
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

      var loginToken =
        randomToken();

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
          email_verified:
            lu.email_verified
        }
      });
    }

    /* =========================
       LOGOUT
    ========================= */

    if (
      path === "/logout" &&
      req.method === "POST"
    ) {
      var logoutUser =
        await getAuthUser(req);

      if (logoutUser) {
        await pool.query(
          `UPDATE users
           SET token=NULL
           WHERE id=$1`,
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

    if (
      path === "/me" &&
      req.method === "GET"
    ) {
      var me =
        await getAuthUser(req);

      if (!me) {
        return json(res, 401, {
          success: false,
          error:
            "وارد نشده‌اید."
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
          email_verified:
            me.email_verified
        }
      });
    }

    /* =========================
       AUTH REQUIRED
    ========================= */

    var authUser =
      await getAuthUser(req);

    if (!authUser) {
      return json(res, 401, {
        success: false,
        error:
          "برای این عملیات باید وارد شوید."
      });
    }

    var shopId =
      authUser.shop_id;

    /* =========================
       PRODUCTS - GET
    ========================= */

    if (
      path === "/products" &&
      req.method === "GET"
    ) {
      var products =
        await pool.query(
          `SELECT *
           FROM products
           WHERE shop_id=$1
           ORDER BY id DESC`,
          [shopId]
        );

      return json(res, 200, {
        success: true,
        products:
          products.rows
      });
    }

    /* =========================
       PRODUCTS - CREATE
    ========================= */

    if (
      path === "/products" &&
      req.method === "POST"
    ) {
      var pb = body(req);

      var pname =
        String(pb.name || "").trim();

      var pbrand =
        String(pb.brand || "").trim();

      var pmodel =
        String(pb.model || "").trim();

      var buyPrice =
        number(pb.buy_price);

      var sellPrice =
        number(pb.sell_price);

      var quantity =
        number(pb.quantity);

      if (!pname) {
        return json(res, 400, {
          success: false,
          error:
            "نام محصول الزامی است."
        });
      }

      var pr =
        await pool.query(
          `INSERT INTO products(
            shop_id,
            name,
            brand,
            model,
            buy_price,
            sell_price,
            quantity
          )
          VALUES($1,$2,$3,$4,$5,$6,$7)
          RETURNING *`,
          [
            shopId,
            pname,
            pbrand,
            pmodel,
            buyPrice,
            sellPrice,
            quantity
          ]
        );

      return json(res, 200, {
        success: true,
        product:
          pr.rows[0]
      });
    }

    /* =========================
       PRODUCT UPDATE
    ========================= */

    if (
      path === "/products" &&
      req.method === "PUT"
    ) {
      var ub = body(req);

      var productId =
        Number(ub.id);

      if (!productId) {
        return json(res, 400, {
          success: false,
          error:
            "شناسه محصول الزامی است."
        });
      }

      var updateProduct =
        await pool.query(
          `UPDATE products
           SET
             name=$1,
             brand=$2,
             model=$3,
             buy_price=$4,
             sell_price=$5,
             quantity=$6
           WHERE id=$7
           AND shop_id=$8
           RETURNING *`,
          [
            String(ub.name || ""),
            String(ub.brand || ""),
            String(ub.model || ""),
            number(ub.buy_price),
            number(ub.sell_price),
            number(ub.quantity),
            productId,
            shopId
          ]
        );

      if (!updateProduct.rows.length) {
        return json(res, 404, {
          success: false,
          error:
            "محصول پیدا نشد."
        });
      }

      return json(res, 200, {
        success: true,
        product:
          updateProduct.rows[0]
      });
    }

    /* =========================
       PRODUCT DELETE
    ========================= */

    if (
      path === "/products" &&
      req.method === "DELETE"
    ) {
      var db = body(req);

      var deleteId =
        Number(
          db.id ||
          db.product_id
        );

      if (!deleteId) {
        return json(res, 400, {
          success: false,
          error:
            "شناسه محصول الزامی است."
        });
      }

      await pool.query(
        `DELETE FROM products
         WHERE id=$1
         AND shop_id=$2`,
        [
          deleteId,
          shopId
        ]
      );

      return json(res, 200, {
        success: true,
        message:
          "محصول حذف شد."
      });
    }

    /* =========================
       BUY
    ========================= */

    if (
      path === "/buy" &&
      req.method === "POST"
    ) {
      var buyBody =
        body(req);

      var buyProductId =
        Number(
          buyBody.product_id ||
          buyBody.productId
        );

      var buyQty =
        number(
          buyBody.quantity
        );

      var buyUnitPrice =
        number(
          buyBody.unit_price ||
          buyBody.price
        );

      var buyCurrency =
        String(
          buyBody.currency ||
          "AFN"
        ).toUpperCase();

      if (
        buyCurrency !== "AFN" &&
        buyCurrency !== "USD"
      ) {
        buyCurrency = "AFN";
      }

      var buyRate =
        currencyRate(
          buyCurrency,
          buyBody.currency_rate ||
            buyBody.rate
        );

      if (
        !buyProductId ||
        buyQty <= 0 ||
        buyUnitPrice < 0
      ) {
        return json(res, 400, {
          success: false,
          error:
            "محصول، تعداد و قیمت خرید را درست وارد کنید."
        });
      }

      var buyProductResult =
        await pool.query(
          `SELECT *
           FROM products
           WHERE id=$1
           AND shop_id=$2
           LIMIT 1`,
          [
            buyProductId,
            shopId
          ]
        );

      if (
        !buyProductResult.rows.length
      ) {
        return json(res, 404, {
          success: false,
          error:
            "محصول پیدا نشد."
        });
      }

      var buyProduct =
        buyProductResult.rows[0];

      var oldStock =
        number(
          buyProduct.quantity
        );

      var oldBuyPrice =
        number(
          buyProduct.buy_price
        );

      var baseBuyUnitPrice =
        buyUnitPrice *
        buyRate;

      var newStock =
        oldStock + buyQty;

      var newAverageBuy;

      if (newStock > 0) {
        newAverageBuy =
          (
            oldStock *
              oldBuyPrice +
            buyQty *
              baseBuyUnitPrice
          ) /
          newStock;
      } else {
        newAverageBuy =
          baseBuyUnitPrice;
      }

      var rawTotal =
        buyQty *
        buyUnitPrice;

      var baseTotal =
        rawTotal *
        buyRate;

      await pool.query(
        `UPDATE products
         SET
           quantity=$1,
           buy_price=$2
         WHERE id=$3
         AND shop_id=$4`,
        [
          newStock,
          newAverageBuy,
          buyProductId,
          shopId
        ]
      );

      var transaction =
        await pool.query(
          `INSERT INTO transactions(
            shop_id,
            product_id,
            user_id,
            type,
            quantity,
            unit_price,
            total,
            buy_cost,
            profit,
            currency,
            currency_rate,
            base_unit_price,
            base_total
          )
          VALUES(
            $1,$2,$3,'buy',
            $4,$5,$6,$7,0,
            $8,$9,$10,$11
          )
          RETURNING *`,
          [
            shopId,
            buyProductId,
            authUser.id,
            buyQty,
            buyUnitPrice,
            rawTotal,
            baseTotal,
            buyCurrency,
            buyRate,
            baseBuyUnitPrice,
            baseTotal
          ]
        );

      return json(res, 200, {
        success: true,
        message:
          "خرید با موفقیت ثبت شد.",
        product: {
          id: buyProductId,
          quantity: newStock,
          buy_price:
            newAverageBuy
        },
        transaction:
          transaction.rows[0]
      });
    }

    /* =========================
       SELL
    ========================= */

    if (
      path === "/sell" &&
      req.method === "POST"
    ) {
      var sellBody =
        body(req);

      var sellProductId =
        Number(
          sellBody.product_id ||
          sellBody.productId
        );

      var sellQty =
        number(
          sellBody.quantity
        );

      var sellUnitPrice =
        number(
          sellBody.unit_price ||
          sellBody.price
        );

      var sellCurrency =
        String(
          sellBody.currency ||
          "AFN"
        ).toUpperCase();

      if (
        sellCurrency !== "AFN" &&
        sellCurrency !== "USD"
      ) {
        sellCurrency = "AFN";
      }

      var sellRate =
        currencyRate(
          sellCurrency,
          sellBody.currency_rate ||
            sellBody.rate
        );

      if (
        !sellProductId ||
        sellQty <= 0 ||
        sellUnitPrice < 0
      ) {
        return json(res, 400, {
          success: false,
          error:
            "محصول، تعداد و قیمت فروش را درست وارد کنید."
        });
      }

      var sellProductResult =
        await pool.query(
          `SELECT *
           FROM products
           WHERE id=$1
           AND shop_id=$2
           LIMIT 1`,
          [
            sellProductId,
            shopId
          ]
        );

      if (
        !sellProductResult.rows.length
      ) {
        return json(res, 404, {
          success: false,
          error:
            "محصول پیدا نشد."
        });
      }

      var sellProduct =
        sellProductResult.rows[0];

      var currentStock =
        number(
          sellProduct.quantity
        );

      if (sellQty > currentStock) {
        return json(res, 400, {
          success: false,
          error:
            "موجودی کافی نیست."
        });
      }

      var averageBuy =
        number(
          sellProduct.buy_price
        );

      var rawSellTotal =
        sellQty *
        sellUnitPrice;

      var baseSellUnitPrice =
        sellUnitPrice *
        sellRate;

      var baseSellTotal =
        rawSellTotal *
        sellRate;

      var buyCost =
        sellQty *
        averageBuy;

      var profit =
        baseSellTotal -
        buyCost;

      var newQuantity =
        currentStock -
        sellQty;

      await pool.query(
        `UPDATE products
         SET quantity=$1
         WHERE id=$2
         AND shop_id=$3`,
        [
          newQuantity,
          sellProductId,
          shopId
        ]
      );

      var sellTransaction =
        await pool.query(
          `INSERT INTO transactions(
            shop_id,
            product_id,
            user_id,
            type,
            quantity,
            unit_price,
            total,
            buy_cost,
            profit,
            currency,
            currency_rate,
            base_unit_price,
            base_total
          )
          VALUES(
            $1,$2,$3,'sell',
            $4,$5,$6,$7,$8,
            $9,$10,$11,$12
          )
          RETURNING *`,
          [
            shopId,
            sellProductId,
            authUser.id,
            sellQty,
            sellUnitPrice,
            rawSellTotal,
            buyCost,
            profit,
            sellCurrency,
            sellRate,
            baseSellUnitPrice,
            baseSellTotal
          ]
        );

      return json(res, 200, {
        success: true,
        message:
          "فروش با موفقیت ثبت شد.",
        product: {
          id: sellProductId,
          quantity:
            newQuantity
        },
        transaction:
          sellTransaction.rows[0]
      });
    }

    /* =========================
       TRANSACTIONS
    ========================= */

    if (
      path === "/transactions" &&
      req.method === "GET"
    ) {
      var transactions =
        await pool.query(
          `SELECT
             t.*,
             p.name AS product_name,
             u.name AS user_name
           FROM transactions t
           LEFT JOIN products p
             ON p.id=t.product_id
           LEFT JOIN users u
             ON u.id=t.user_id
           WHERE t.shop_id=$1
           ORDER BY t.id DESC
           LIMIT 500`,
          [shopId]
        );

      return json(res, 200, {
        success: true,
        transactions:
          transactions.rows
      });
    }

    /* =========================
       HISTORY
    ========================= */

    if (
      path === "/history" &&
      req.method === "GET"
    ) {
      var history =
        await pool.query(
          `SELECT
             t.*,
             p.name AS product_name,
             u.name AS user_name
           FROM transactions t
           LEFT JOIN products p
             ON p.id=t.product_id
           LEFT JOIN users u
             ON u.id=t.user_id
           WHERE t.shop_id=$1
           ORDER BY t.created_at DESC
           LIMIT 500`,
          [shopId]
        );

      return json(res, 200, {
        success: true,
        transactions:
          history.rows
      });
    }

    /* =========================
       DASHBOARD
    ========================= */

    if (
      path === "/dashboard" &&
      req.method === "GET"
    ) {
      var stats =
        await pool.query(
          `SELECT
            COALESCE(
              SUM(
                CASE
                  WHEN type='sell'
                  THEN base_total
                  ELSE 0
                END
              ),0
            ) AS sales,

            COALESCE(
              SUM(
                CASE
                  WHEN type='buy'
                  THEN base_total
                  ELSE 0
                END
              ),0
            ) AS purchases,

            COALESCE(
              SUM(
                CASE
                  WHEN type='sell'
                  THEN profit
                  ELSE 0
                END
              ),0
            ) AS profit

           FROM transactions
           WHERE shop_id=$1`,
          [shopId]
        );

      var countResult =
        await pool.query(
          `SELECT
             COUNT(*) AS products,
             COALESCE(
               SUM(quantity),0
             ) AS stock
           FROM products
           WHERE shop_id=$1`,
          [shopId]
        );

      var currencyStats =
        await pool.query(
          `SELECT
             type,
             currency,
             COALESCE(SUM(total),0) AS total,
             COALESCE(SUM(base_total),0) AS base_total
           FROM transactions
           WHERE shop_id=$1
           GROUP BY type,currency
           ORDER BY type,currency`,
          [shopId]
        );

      return json(res, 200, {
        success: true,
        sales:
          number(
            stats.rows[0].sales
          ),
        purchases:
          number(
            stats.rows[0].purchases
          ),
        profit:
          number(
            stats.rows[0].profit
          ),
        products:
          Number(
            countResult.rows[0].products
          ),
        stock:
          number(
            countResult.rows[0].stock
          ),
        currency:
          currencyStats.rows
      });
    }

    /* =========================
       PORTFOLIO / STOCK
    ========================= */

    if (
      path === "/portfolio" &&
      req.method === "GET"
    ) {
      var portfolio =
        await pool.query(
          `SELECT
             id,
             name,
             brand,
             model,
             buy_price,
             sell_price,
             quantity,
             quantity * buy_price AS stock_cost,
             quantity * sell_price AS stock_value
           FROM products
           WHERE shop_id=$1
           ORDER BY id DESC`,
          [shopId]
        );

      return json(res, 200, {
        success: true,
        portfolio:
          portfolio.rows
      });
    }

    /* =========================
       WORKERS
    ========================= */

    if (
      path === "/workers" &&
      req.method === "GET"
    ) {
      if (
        authUser.role !== "owner"
      ) {
        return json(res, 403, {
          success: false,
          error:
            "فقط صاحب دوکان دسترسی دارد."
        });
      }

      var workers =
        await pool.query(
          `SELECT
             id,
             shop_id,
             name,
             username,
             email,
             role,
             email_verified,
             created_at
           FROM users
           WHERE shop_id=$1
           ORDER BY id DESC`,
          [shopId]
        );

      return json(res, 200, {
        success: true,
        workers:
          workers.rows
      });
    }

    /* =========================
       ADD WORKER
    ========================= */

    if (
      path === "/workers" &&
      req.method === "POST"
    ) {
      if (
        authUser.role !== "owner"
      ) {
        return json(res, 403, {
          success: false,
          error:
            "فقط صاحب دوکان می‌تواند کارمند اضافه کند."
        });
      }

      var wb = body(req);

      var workerName =
        String(
          wb.name ||
            wb.username ||
            ""
        ).trim();

      var workerEmail =
        normalizeEmail(
          wb.email
        );

      var workerPassword =
        String(
          wb.password || ""
        );

      if (
        !workerName ||
        !workerEmail ||
        !workerPassword
      ) {
        return json(res, 400, {
          success: false,
          error:
            "نام، ایمیل و رمز عبور کارمند الزامی است."
        });
      }

      if (
        workerPassword.length < 6
      ) {
        return json(res, 400, {
          success: false,
          error:
            "رمز عبور باید حداقل ۶ حرف باشد."
        });
      }

      var existingWorker =
        await pool.query(
          `SELECT id
           FROM users
           WHERE email=$1
           LIMIT 1`,
          [workerEmail]
        );

      if (
        existingWorker.rows.length
      ) {
        return json(res, 400, {
          success: false,
          error:
            "این ایمیل قبلاً استفاده شده است."
        });
      }

      var workerHash =
        hashPassword(
          workerPassword
        );

      var worker =
        await pool.query(
          `INSERT INTO users(
            shop_id,
            name,
            username,
            email,
            password,
            password_hash,
            role,
            email_verified
          )
          VALUES(
            $1,$2,$2,$3,$4,$5,
            'worker',
            TRUE
          )
          RETURNING
            id,
            shop_id,
            name,
            username,
            email,
            role`,
          [
            shopId,
            workerName,
            workerEmail,
            workerHash,
            workerHash
          ]
        );

      return json(res, 200, {
        success: true,
        message:
          "کارمند اضافه شد.",
        worker:
          worker.rows[0]
      });
    }

    /* =========================
       DELETE WORKER
    ========================= */

    if (
      path === "/workers" &&
      req.method === "DELETE"
    ) {
      if (
        authUser.role !== "owner"
      ) {
        return json(res, 403, {
          success: false,
          error:
            "فقط صاحب دوکان دسترسی دارد."
        });
      }

      var deleteWorkerBody =
        body(req);

      var workerId =
        Number(
          deleteWorkerBody.id ||
            deleteWorkerBody.user_id
        );

      if (!workerId) {
        return json(res, 400, {
          success: false,
          error:
            "شناسه کارمند الزامی است."
        });
      }

      await pool.query(
        `DELETE FROM users
         WHERE id=$1
         AND shop_id=$2
         AND role='worker'`,
        [
          workerId,
          shopId
        ]
      );

      return json(res, 200, {
        success: true,
        message:
          "کارمند حذف شد."
      });
    }

    /* =========================
       SHOP
    ========================= */

    if (
      path === "/shop" &&
      req.method === "GET"
    ) {
      var shopResult =
        await pool.query(
          `SELECT *
           FROM shops
           WHERE id=$1
           LIMIT 1`,
          [shopId]
        );

      if (!shopResult.rows.length) {
        return json(res, 404, {
          success: false,
          error:
            "دوکان پیدا نشد."
        });
      }

      return json(res, 200, {
        success: true,
        shop:
          shopResult.rows[0]
      });
    }

    /* =========================
       SHOP UPDATE
    ========================= */

    if (
      path === "/shop" &&
      req.method === "PUT"
    ) {
      if (
        authUser.role !== "owner"
      ) {
        return json(res, 403, {
          success: false,
          error:
            "فقط صاحب دوکان می‌تواند تنظیمات را تغییر دهد."
        });
      }

      var shopBody =
        body(req);

      var updatedShop =
        await pool.query(
          `UPDATE shops
           SET
             name=$1,
             phone=$2,
             address=$3
           WHERE id=$4
           RETURNING *`,
          [
            String(
              shopBody.name || ""
            ),
            String(
              shopBody.phone || ""
            ),
            String(
              shopBody.address || ""
            ),
            shopId
          ]
        );

      return json(res, 200, {
        success: true,
        shop:
          updatedShop.rows[0]
      });
    }

    /* =========================
       USER
    ========================= */

    if (
      path === "/user" &&
      req.method === "GET"
    ) {
      return json(res, 200, {
        success: true,
        user: {
          id: authUser.id,
          shop_id:
            authUser.shop_id,
          name:
            authUser.name,
          username:
            authUser.username,
          email:
            authUser.email,
          role:
            authUser.role,
          email_verified:
            authUser.email_verified
        }
      });
    }

    /* =========================
       UNKNOWN
    ========================= */

    return json(res, 404, {
      success: false,
      error:
        "Endpoint not found",
      path: path
    });

  } catch (error) {
    console.error(
      "DOKANYAAR API ERROR:",
      error
    );

    return json(res, 500, {
      success: false,
      error:
        error &&
        error.message
          ? error.message
          : "خطای داخلی سرور"
    });
  }
};