const { Pool } = require("pg");
const crypto = require("crypto");

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
const hash = (s) =>
  crypto.createHash("sha256").update(String(s)).digest("hex");
const token = () => crypto.randomBytes(32).toString("hex");
const code6 = () => String(crypto.randomInt(100000, 1000000));
const clean = (s, max = 180) => String(s || "").trim().slice(0, max);
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'دوکان من',
      owner_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'owner',
      token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_id, username)
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cost_price NUMERIC(14,2) DEFAULT 0,
      price NUMERIC(14,2) DEFAULT 0,
      quantity NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name TEXT DEFAULT '',
      type TEXT NOT NULL,
      quantity NUMERIC(14,2) DEFAULT 0,
      price NUMERIC(14,2) DEFAULT 0,
      total NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER UNIQUE REFERENCES shops(id) ON DELETE CASCADE,
      plan TEXT DEFAULT 'permanent',
      status TEXT DEFAULT 'pending',
      amount_usdt NUMERIC(12,2) DEFAULT 10,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      user_id INTEGER,
      amount_usdt NUMERIC(12,2) DEFAULT 10,
      currency TEXT DEFAULT 'USDT',
      plan TEXT DEFAULT 'permanent',
      status TEXT DEFAULT 'pending',
      reference TEXT,
      note TEXT,
      payment_method TEXT DEFAULT 'Binance Pay',
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_usdt NUMERIC(12,2) DEFAULT 10;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USDT';
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'Binance Pay';

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users(LOWER(email)) WHERE email IS NOT NULL;
  `);
}

async function emailCode(email, code) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!key || !from) {
    throw new Error(
      "ارسال ایمیل تنظیم نشده است. متغیرهای RESEND_API_KEY و EMAIL_FROM را در Vercel اضافه کنید."
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "کد تأیید دوکان‌یار",
      html: `<div dir="rtl"><h2>دوکان‌یار</h2><p>کد تأیید شما:</p><h1>${code}</h1><p>اعتبار کد ۱۵ دقیقه است.</p></div>`,
    }),
  });

  if (!response.ok) {
    throw new Error("ارسال ایمیل ناموفق بود. تنظیمات ایمیل را بررسی کنید.");
  }
}

function requestPath(req) {
  const url = new URL(req.url, "https://local.invalid");
  if (url.searchParams.has("path")) {
    return "/" + url.searchParams.get("path").replace(/^\/+|\/+$/g, "");
  }
  return url.pathname.replace(/^\/api\/?/, "/").replace(/\/$/, "") || "/";
}

function getBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

async function getUser(req) {
  const auth = req.headers.authorization || "";
  const t = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : req.headers["x-auth-token"];

  if (!t) return null;

  const result = await pool.query(
    `SELECT u.*, s.name AS shop_name, s.owner_name
     FROM users u LEFT JOIN shops s ON s.id = u.shop_id
     WHERE u.token = $1 LIMIT 1`,
    [t]
  );

  return result.rows[0] || null;
}

async function handler(req, res) {
  const path = requestPath(req);
  const method = req.method.toUpperCase();
  const b = getBody(req);
  const parts = path.split("/").filter(Boolean);

  if (method === "OPTIONS") return res.status(204).end();

  if (method === "GET" && (path === "/" || path === "/health")) {
    return send(res, 200, {
      success: true,
      app: "DokanYar",
      status: "running",
    });
  }

  await setup();

  if (method === "POST" && path === "/setup") {
    return send(res, 200, {
      success: true,
      message: "دیتابیس آماده است.",
    });
  }

  if (method === "POST" && path === "/register") {
    const email = clean(b.email, 254).toLowerCase();
    const password = String(b.password || "");
    const shopName = clean(b.shop_name || "دوکان من");
    const fullName = clean(b.full_name || b.name || "صاحب دوکان");

    if (!validEmail(email)) {
      return send(res, 400, {
        success: false,
        error: "ایمیل معتبر وارد کنید.",
      });
    }

    if (password.length < 8) {
      return send(res, 400, {
        success: false,
        error: "رمز عبور باید حداقل ۸ حرف باشد.",
      });
    }

    const exists = await pool.query(
      "SELECT id FROM users WHERE LOWER(email)=LOWER($1)",
      [email]
    );

    if (exists.rowCount) {
      return send(res, 409, {
        success: false,
        error: "این ایمیل قبلاً ثبت شده است.",
      });
    }

    const verificationCode = code6();
    const client = await pool.connect();

    let userId;

    try {
      await client.query("BEGIN");

      const shop = await client.query(
        "INSERT INTO shops(name,owner_name) VALUES($1,$2) RETURNING id",
        [shopName, fullName]
      );

      const shopId = shop.rows[0].id;

      const user = await client.query(
        `INSERT INTO users
         (shop_id,username,email,password_hash,full_name,role,
          email_verified,verification_code_hash,verification_expires_at)
         VALUES($1,$2,$2,$3,$4,'owner',FALSE,$5,NOW()+INTERVAL '15 minutes')
         RETURNING id`,
        [
          shopId,
          email,
          hash(password),
          fullName,
          hash(verificationCode),
        ]
      );

      userId = user.rows[0].id;

      await client.query(
        `INSERT INTO subscriptions(shop_id,plan,status,amount_usdt)
         VALUES($1,'permanent','pending',10)
         ON CONFLICT(shop_id) DO UPDATE
         SET plan='permanent',status='pending',amount_usdt=10`,
        [shopId]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    try {
      await emailCode(email, verificationCode);
    } catch (error) {
      console.error("Email error:", error.message);
      return send(res, 503, {
        success: false,
        account_created: true,
        error: error.message,
      });
    }

    return send(res, 201, {
      success: true,
      user_id: userId,
      message: "کد تأیید به ایمیل شما فرستاده شد.",
    });
  }

  if (
    method === "POST" &&
    (path === "/verify-email" || path === "/resend-code")
  ) {
    const email = clean(b.email, 254).toLowerCase();

    if (!validEmail(email)) {
      return send(res, 400, {
        success: false,
        error: "ایمیل معتبر وارد کنید.",
      });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1",
      [email]
    );

    if (!result.rowCount) {
      return send(res, 404, {
        success: false,
        error: "حساب پیدا نشد.",
      });
    }

    const user = result.rows[0];

    if (path === "/verify-email") {
      const expired =
        !user.verification_expires_at ||
        new Date(user.verification_expires_at) < new Date();

      if (
        expired ||
        !b.code ||
        hash(String(b.code).trim()) !== user.verification_code_hash
      ) {
        return send(res, 400, {
          success: false,
          error: "کد نادرست است یا اعتبار آن پایان یافته است.",
        });
      }

      await pool.query(
        `UPDATE users SET email_verified=TRUE,
         verification_code_hash=NULL,verification_expires_at=NULL
         WHERE id=$1`,
        [user.id]
      );

      return send(res, 200, {
        success: true,
        message: "ایمیل تأیید شد. اکنون وارد شوید.",
      });
    }

    const newCode = code6();

    await pool.query(
      `UPDATE users SET verification_code_hash=$1,
       verification_expires_at=NOW()+INTERVAL '15 minutes'
       WHERE id=$2`,
      [hash(newCode), user.id]
    );

    try {
      await emailCode(email, newCode);
    } catch (error) {
      return send(res, 503, { success: false, error: error.message });
    }

    return send(res, 200, {
      success: true,
      message: "کد تأیید دوباره ارسال شد.",
    });
  }

  if (method === "POST" && path === "/login") {
    const email = clean(b.email || b.username, 254).toLowerCase();
    const password = String(b.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(COALESCE(email,username))=LOWER($1) LIMIT 1",
      [email]
    );

    if (
      !result.rowCount ||
      result.rows[0].password_hash !== hash(password)
    ) {
      return send(res, 401, {
        success: false,
        error: "ایمیل یا رمز عبور نادرست است.",
      });
    }

    const user = result.rows[0];

    if (user.email && !user.email_verified) {
      return send(res, 403, {
        success: false,
        error: "ابتدا ایمیل خود را تأیید کنید.",
      });
    }

    const newToken = token();

    await pool.query("UPDATE users SET token=$1 WHERE id=$2", [
      newToken,
      user.id,
    ]);

    const subscription = await pool.query(
      "SELECT * FROM subscriptions WHERE shop_id=$1",
      [user.shop_id]
    );

    return send(res, 200, {
      success: true,
      token: newToken,
      user: {
        id: user.id,
        shop_id: user.shop_id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        email_verified: user.email_verified,
      },
      subscription: subscription.rows[0] || null,
    });
  }

  const user = await getUser(req);

  if (path === "/logout" && method === "POST") {
    if (user) {
      await pool.query("UPDATE users SET token=NULL WHERE id=$1", [
        user.id,
      ]);
    }
    return send(res, 200, { success: true });
  }

  if (!user) {
    return send(res, 401, {
      success: false,
      error: "ابتدا وارد حساب شوید.",
    });
  }

  if (user.email && !user.email_verified) {
    return send(res, 403, {
      success: false,
      error: "ابتدا ایمیل خود را تأیید کنید.",
    });
  }

  if (method === "GET" && path === "/me") {
    return send(res, 200, {
      success: true,
      user: {
        id: user.id,
        shop_id: user.shop_id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        email_verified: user.email_verified,
        shop_name: user.shop_name,
        owner_name: user.owner_name,
      },
    });
  }

  if (method === "GET" && path === "/subscription") {
    const sub = await pool.query(
      "SELECT * FROM subscriptions WHERE shop_id=$1",
      [user.shop_id]
    );

    const payments = await pool.query(
      `SELECT id,amount_usdt,currency,status,reference,created_at
       FROM payments WHERE shop_id=$1 ORDER BY id DESC LIMIT 10`,
      [user.shop_id]
    );

    return send(res, 200, {
      success: true,
      subscription: sub.rows[0] || { status: "pending", plan: "permanent" },
      payments: payments.rows,
    });
  }

  if (method === "POST" && path === "/upgrade-request") {
    const reference = clean(b.reference, 180);

    if (!reference) {
      return send(res, 400, {
        success: false,
        error: "شماره مرجع پرداخت را وارد کنید.",
      });
    }

    const duplicate = await pool.query(
      "SELECT id FROM payments WHERE shop_id=$1 AND reference=$2 AND status='pending'",
      [user.shop_id, reference]
    );

    if (duplicate.rowCount) {
      return send(res, 409, {
        success: false,
        error: "این درخواست قبلاً ثبت شده است.",
      });
    }

    const result = await pool.query(
      `INSERT INTO payments
       (shop_id,user_id,amount_usdt,currency,plan,status,reference,note,payment_method)
       VALUES($1,$2,10,'USDT','permanent','pending',$3,$4,'Binance Pay')
       RETURNING id,status,amount_usdt,currency,reference,created_at`,
      [user.shop_id, user.id, reference, clean(b.note, 500)]
    );

    await pool.query(
      `INSERT INTO subscriptions(shop_id,plan,status,amount_usdt)
       VALUES($1,'permanent','pending',10)
       ON CONFLICT(shop_id) DO UPDATE SET
       plan='permanent',
       status=CASE WHEN subscriptions.status='active'
       THEN subscriptions.status ELSE 'pending' END,
       amount_usdt=10`,
      [user.shop_id]
    );

    return send(res, 201, {
      success: true,
      message: "درخواست ثبت شد و منتظر بررسی مدیر است.",
      payment: result.rows[0],
    });
  }

  if (method === "GET" && path === "/products") {
    const result = await pool.query(
      "SELECT * FROM products WHERE shop_id=$1 ORDER BY id DESC",
      [user.shop_id]
    );
    return send(res, 200, { success: true, products: result.rows });
  }

  if (method === "POST" && path === "/products") {
    const name = clean(b.name);
    const cost = Number(b.cost_price ?? b.buy_price ?? 0);
    const price = Number(b.price ?? b.sell_price ?? 0);
    const quantity = Number(b.quantity ?? b.stock ?? 0);

    if (
      !name ||
      ![cost, price, quantity].every(Number.isFinite) ||
      cost < 0 ||
      price < 0 ||
      quantity < 0
    ) {
      return send(res, 400, {
        success: false,
        error: "اطلاعات کالا معتبر نیست.",
      });
    }

    const result = await pool.query(
      `INSERT INTO products(shop_id,name,cost_price,price,quantity)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [user.shop_id, name, cost, price, quantity]
    );

    return send(res, 201, {
      success: true,
      product: result.rows[0],
      message: "کالا اضافه شد.",
    });
  }

  if (parts[0] === "products" && parts[1] && method === "DELETE") {
    const result = await pool.query(
      "DELETE FROM products WHERE id=$1 AND shop_id=$2 RETURNING id",
      [Number(parts[1]), user.shop_id]
    );

    if (!result.rowCount) {
      return send(res, 404, {
        success: false,
        error: "کالا پیدا نشد.",
      });
    }

    return send(res, 200, { success: true });
  }

  if (
    (path === "/buy" || path === "/sell") &&
    method === "POST"
  ) {
    const productId = Number(b.product_id);
    const quantity = Number(b.quantity);
    const price = Number(b.price);

    if (
      !Number.isInteger(productId) ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return send(res, 400, {
        success: false,
        error: "تعداد و قیمت معتبر وارد کنید.",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const found = await client.query(
        "SELECT * FROM products WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [productId, user.shop_id]
      );

      if (!found.rowCount) throw new Error("کالا پیدا نشد.");

      const product = found.rows[0];
      const isSell = path === "/sell";
      const oldQuantity = Number(product.quantity || 0);

      if (isSell && oldQuantity < quantity) {
        throw new Error("موجودی کالا کافی نیست.");
      }

      const newQuantity = isSell
        ? oldQuantity - quantity
        : oldQuantity + quantity;

      const total = quantity * price;

      await client.query(
        `UPDATE products SET quantity=$1,
         cost_price=CASE WHEN $2='buy' THEN $3 ELSE cost_price END,
         price=CASE WHEN $2='sell' THEN $3 ELSE price END
         WHERE id=$4 AND shop_id=$5`,
        [
          newQuantity,
          isSell ? "sell" : "buy",
          price,
          productId,
          user.shop_id,
        ]
      );

      await client.query(
        `INSERT INTO transactions
         (shop_id,product_id,product_name,type,quantity,price,total)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          user.shop_id,
          productId,
          product.name,
          isSell ? "sell" : "buy",
          quantity,
          price,
          total,
        ]
      );

      await client.query("COMMIT");

      return send(res, 200, {
        success: true,
        message: isSell ? "فروش ثبت شد." : "خرید ثبت شد.",
        new_quantity: newQuantity,
        stock: newQuantity,
        total,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return send(res, 400, {
        success: false,
        error: error.message || "عملیات انجام نشد.",
      });
    } finally {
      client.release();
    }
  }

  if (method === "GET" && path === "/transactions") {
    const result = await pool.query(
      "SELECT * FROM transactions WHERE shop_id=$1 ORDER BY id DESC LIMIT 500",
      [user.shop_id]
    );

    return send(res, 200, { success: true, transactions: result.rows });
  }

  if (method === "GET" && path === "/workers") {
    const result = await pool.query(
      `SELECT id,username,email,full_name,role,created_at
       FROM users WHERE shop_id=$1 AND role='worker' ORDER BY id DESC`,
      [user.shop_id]
    );

    return send(res, 200, { success: true, workers: result.rows });
  }

  if (method === "POST" && path === "/workers") {
    if (user.role !== "owner" && user.role !== "admin") {
      return send(res, 403, {
        success: false,
        error: "فقط صاحب دوکان می‌تواند کارمند اضافه کند.",
      });
    }

    const email = clean(b.email || b.username, 254).toLowerCase();
    const name = clean(b.full_name || b.name);
    const password = String(b.password || "");

    if (!email || password.length < 8) {
      return send(res, 400, {
        success: false,
        error: "ایمیل و رمز حداقل ۸ حرفی وارد کنید.",
      });
    }

    const duplicate = await pool.query(
      "SELECT id FROM users WHERE shop_id=$1 AND LOWER(username)=LOWER($2)",
      [user.shop_id, email]
    );

    if (duplicate.rowCount) {
      return send(res, 409, {
        success: false,
        error: "این کارمند قبلاً ثبت شده است.",
      });
    }

    const result = await pool.query(
      `INSERT INTO users
       (shop_id,username,email,password_hash,full_name,role,email_verified)
       VALUES($1,$2,$2,$3,$4,'worker',TRUE)
       RETURNING id,username,email,full_name,role`,
      [user.shop_id, email, hash(password), name]
    );

    return send(res, 201, {
      success: true,
      worker: result.rows[0],
      message: "کارمند اضافه شد.",
    });
  }

  if (parts[0] === "workers" && parts[1] && method === "DELETE") {
    if (user.role !== "owner" && user.role !== "admin") {
      return send(res, 403, {
        success: false,
        error: "اجازه حذف کارمند را ندارید.",
      });
    }

    const id = Number(parts[1]);

    if (id === user.id) {
      return send(res, 400, {
        success: false,
        error: "حساب خودتان را نمی‌توانید حذف کنید.",
      });
    }

    const result = await pool.query(
      "DELETE FROM users WHERE id=$1 AND shop_id=$2 AND role='worker' RETURNING id",
      [id, user.shop_id]
    );

    if (!result.rowCount) {
      return send(res, 404, {
        success: false,
        error: "کارمند پیدا نشد.",
      });
    }

    return send(res, 200, { success: true });
  }

  if (method === "GET" && path === "/shop") {
    return send(res, 200, {
      success: true,
      shop: {
        id: user.shop_id,
        name: user.shop_name,
        owner_name: user.owner_name,
      },
    });
  }

  if (method === "PUT" && path === "/shop") {
    const name = clean(b.name || b.shop_name);
    const ownerName = clean(b.owner_name);

    const result = await pool.query(
      `UPDATE shops SET
       name=CASE WHEN $1='' THEN name ELSE $1 END,
       owner_name=CASE WHEN $2='' THEN owner_name ELSE $2 END
       WHERE id=$3 RETURNING *`,
      [name, ownerName, user.shop_id]
    );

    return send(res, 200, { success: true, shop: result.rows[0] });
  }

  // مدیر: POST /api/admin/approve-payment
  // Header: x-admin-key: مقدار DOKANYAAR_ADMIN_KEY
  if (
    method === "POST" &&
    path === "/admin/approve-payment"
  ) {
    const adminKey = process.env.DOKANYAAR_ADMIN_KEY;

    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return send(res, 403, {
        success: false,
        error: "دسترسی مدیر رد شد.",
      });
    }

    const paymentId = Number(b.payment_id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const payment = await client.query(
        "SELECT * FROM payments WHERE id=$1 FOR UPDATE",
        [paymentId]
      );

      if (!payment.rowCount) throw new Error("درخواست پرداخت پیدا نشد.");

      const p = payment.rows[0];

      await client.query(
        "UPDATE payments SET status='approved',paid_at=NOW() WHERE id=$1",
        [paymentId]
      );

      await client.query(
        `INSERT INTO subscriptions(shop_id,plan,status,amount_usdt,starts_at,expires_at)
         VALUES($1,'permanent','active',10,NOW(),NULL)
         ON CONFLICT(shop_id) DO UPDATE SET
         plan='permanent',status='active',amount_usdt=10,
         starts_at=COALESCE(subscriptions.starts_at,NOW()),expires_at=NULL`,
        [p.shop_id]
      );

      await client.query("COMMIT");

      return send(res, 200, {
        success: true,
        message: "پرداخت تأیید و حساب فعال شد.",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return send(res, 400, {
        success: false,
        error: error.message,
      });
    } finally {
      client.release();
    }
  }

  if (method === "GET" && path === "/admin/pending-payments") {
    const adminKey = process.env.DOKANYAAR_ADMIN_KEY;

    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return send(res, 403, {
        success: false,
        error: "دسترسی مدیر رد شد.",
      });
    }

    const result = await pool.query(
      `SELECT p.*,s.name AS shop_name,u.email
       FROM payments p
       LEFT JOIN shops s ON s.id=p.shop_id
       LEFT JOIN users u ON u.id=p.user_id
       WHERE p.status='pending'
       ORDER BY p.id DESC`
    );

    return send(res, 200, { success: true, payments: result.rows });
  }

  return send(res, 404, {
    success: false,
    error: "Endpoint not found",
    path,
  });
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  const allowed = (
    process.env.ALLOWED_ORIGINS ||
    "https://dokanyar-six.vercel.app,https://yazdanmadadiafghanicoin.github.io"
  )
    .split(",")
    .map((x) => x.trim());

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Auth-Token, X-Admin-Key"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );

  try {
    return await handler(req, res);
  } catch (error) {
    console.error("DokanYar API error:", error);
    return send(res, 500, {
      success: false,
      error: "خطای سرور. تنظیمات دیتابیس و لاگ Vercel را بررسی کنید.",
    });
  }
};