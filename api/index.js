
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
const clean = (s, max = 180) => String(s ?? "").trim().slice(0, max);
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
      barcode TEXT,
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
      profit NUMERIC(14,2) NOT NULL DEFAULT 0,
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
    ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS profit NUMERIC(14,2) NOT NULL DEFAULT 0;

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
      ON users(LOWER(email)) WHERE email IS NOT NULL;

    CREATE INDEX IF NOT EXISTS products_shop_idx ON products(shop_id);
    CREATE INDEX IF NOT EXISTS products_barcode_idx ON products(shop_id, barcode);
    CREATE INDEX IF NOT EXISTS transactions_shop_idx ON transactions(shop_id, created_at);

    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_payments (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shop_expenses (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sale_receipts (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      transaction_id INTEGER,
      receipt_number TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      total NUMERIC(14,2) NOT NULL DEFAULT 0,
      paid NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_id, receipt_number)
    );

    CREATE TABLE IF NOT EXISTS worker_permissions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      can_sell BOOLEAN NOT NULL DEFAULT TRUE,
      can_buy BOOLEAN NOT NULL DEFAULT FALSE,
      can_manage_products BOOLEAN NOT NULL DEFAULT FALSE,
      can_view_reports BOOLEAN NOT NULL DEFAULT FALSE,
      can_manage_workers BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(user_id, shop_id)
    );

    CREATE INDEX IF NOT EXISTS customers_shop_idx ON customers(shop_id);
    CREATE INDEX IF NOT EXISTS customer_payments_shop_idx ON customer_payments(shop_id, customer_id);
    CREATE INDEX IF NOT EXISTS shop_expenses_shop_idx ON shop_expenses(shop_id, created_at);
    CREATE INDEX IF NOT EXISTS receipts_shop_idx ON sale_receipts(shop_id, created_at);
  `);
}

async function emailCode(email, code) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    throw new Error("ارسال ایمیل تنظیم نشده است؛ RESEND_API_KEY و EMAIL_FROM را در Vercel تنظیم کنید.");
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

  if (!response.ok) throw new Error("ارسال ایمیل ناموفق بود؛ تنظیمات ایمیل را بررسی کنید.");
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

function queryOf(req, key, fallback = "") {
  return new URL(req.url, "https://local.invalid").searchParams.get(key) ?? fallback;
}

async function getUser(req) {
  const auth = req.headers.authorization || "";
  const t = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : req.headers["x-auth-token"];

  if (!t) return null;

  const result = await pool.query(
    `SELECT u.*, s.name AS shop_name, s.owner_name
     FROM users u
     LEFT JOIN shops s ON s.id = u.shop_id
     WHERE u.token = $1 LIMIT 1`,
    [t]
  );

  return result.rows[0] || null;
}

async function permissions(user) {
  if (user.role === "owner" || user.role === "admin") {
    return {
      can_sell: true,
      can_buy: true,
      can_manage_products: true,
      can_view_reports: true,
      can_manage_workers: true,
    };
  }

  const result = await pool.query(
    `SELECT can_sell, can_buy, can_manage_products,
            can_view_reports, can_manage_workers
     FROM worker_permissions WHERE user_id=$1 AND shop_id=$2`,
    [user.id, user.shop_id]
  );

  return result.rows[0] || {
    can_sell: true,
    can_buy: false,
    can_manage_products: false,
    can_view_reports: false,
    can_manage_workers: false,
  };
}

async function requirePermission(user, permission) {
  const p = await permissions(user);
  return Boolean(p[permission]);
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
    return send(res, 200, { success: true, message: "دیتابیس آماده است." });
  }

  if (method === "POST" && path === "/register") {
    const email = clean(b.email, 254).toLowerCase();
    const password = String(b.password || "");
    const shopName = clean(b.shop_name || "دوکان من");
    const fullName = clean(b.full_name || b.name || "صاحب دوکان");

    if (!validEmail(email)) {
      return send(res, 400, { success: false, error: "ایمیل معتبر وارد کنید." });
    }
    if (password.length < 8) {
      return send(res, 400, { success: false, error: "رمز عبور باید حداقل ۸ حرف باشد." });
    }

    const exists = await pool.query(
      "SELECT id FROM users WHERE LOWER(email)=LOWER($1)",
      [email]
    );
    if (exists.rowCount) {
      return send(res, 409, { success: false, error: "این ایمیل قبلاً ثبت شده است." });
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
        [shopId, email, hash(password), fullName, hash(verificationCode)]
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
      if (error.code === "23505") {
        return send(res, 409, { success: false, error: "این ایمیل قبلاً ثبت شده است." });
      }
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

  if (method === "POST" && (path === "/verify-email" || path === "/resend-code")) {
    const email = clean(b.email, 254).toLowerCase();
    if (!validEmail(email)) {
      return send(res, 400, { success: false, error: "ایمیل معتبر وارد کنید." });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1",
      [email]
    );
    if (!result.rowCount) {
      return send(res, 404, { success: false, error: "حساب پیدا نشد." });
    }

    const user = result.rows[0];

    if (path === "/verify-email") {
      const expired =
        !user.verification_expires_at ||
        new Date(user.verification_expires_at) < new Date();

      if (expired || !b.code || hash(String(b.code).trim()) !== user.verification_code_hash) {
        return send(res, 400, {
          success: false,
          error: "کد نادرست است یا اعتبار آن پایان یافته است.",
        });
      }

      await pool.query(
        `UPDATE users SET email_verified=TRUE,
         verification_code_hash=NULL, verification_expires_at=NULL
         WHERE id=$1`,
        [user.id]
      );

      return send(res, 200, { success: true, message: "ایمیل تأیید شد. اکنون وارد شوید." });
    }

    if (user.email_verified) {
      return send(res, 200, { success: true, message: "ایمیل شما قبلاً تأیید شده است." });
    }

    const newCode = code6();
    await pool.query(
      `UPDATE users SET verification_code_hash=$1,
       verification_expires_at=NOW()+INTERVAL '15 minutes' WHERE id=$2`,
      [hash(newCode), user.id]
    );

    try {
      await emailCode(email, newCode);
    } catch (error) {
      return send(res, 503, { success: false, error: error.message });
    }

    return send(res, 200, { success: true, message: "کد تأیید دوباره ارسال شد." });
  }

  if (method === "POST" && path === "/login") {
    const email = clean(b.email || b.username, 254).toLowerCase();
    const password = String(b.password || "");

    const result = await pool.query(
      `SELECT * FROM users
       WHERE LOWER(COALESCE(email,username))=LOWER($1) LIMIT 1`,
      [email]
    );

    if (!result.rowCount || result.rows[0].password_hash !== hash(password)) {
      return send(res, 401, { success: false, error: "ایمیل یا رمز عبور نادرست است." });
    }

    const user = result.rows[0];
    if (user.email && !user.email_verified) {
      return send(res, 403, { success: false, error: "ابتدا ایمیل خود را تأیید کنید." });
    }

    const newToken = token();
    await pool.query("UPDATE users SET token=$1 WHERE id=$2", [newToken, user.id]);

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
    if (user) await pool.query("UPDATE users SET token=NULL WHERE id=$1", [user.id]);
    return send(res, 200, { success: true });
  }

  if (!user) {
    return send(res, 401, { success: false, error: "ابتدا وارد حساب شوید." });
  }

  if (user.email && !user.email_verified) {
    return send(res, 403, { success: false, error: "ابتدا ایمیل خود را تأیید کنید." });
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
    const [sub, payments] = await Promise.all([
      pool.query("SELECT * FROM subscriptions WHERE shop_id=$1", [user.shop_id]),
      pool.query(
        `SELECT id,amount_usdt,currency,status,reference,created_at
         FROM payments WHERE shop_id=$1 ORDER BY id DESC LIMIT 10`,
        [user.shop_id]
      ),
    ]);
    return send(res, 200, {
      success: true,
      subscription: sub.rows[0] || { status: "pending", plan: "permanent" },
      payments: payments.rows,
    });
  }

  if (method === "POST" && path === "/upgrade-request") {
    const reference = clean(b.reference, 180);
    if (!reference) {
      return send(res, 400, { success: false, error: "شماره مرجع پرداخت را وارد کنید." });
    }

    const duplicate = await pool.query(
      "SELECT id FROM payments WHERE shop_id=$1 AND reference=$2 AND status='pending'",
      [user.shop_id, reference]
    );
    if (duplicate.rowCount) {
      return send(res, 409, { success: false, error: "این درخواست قبلاً ثبت شده است." });
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
       status=CASE WHEN subscriptions.status='active' THEN subscriptions.status ELSE 'pending' END,
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
    const barcode = clean(queryOf(req, "barcode"), 100);
    const search = clean(queryOf(req, "search"), 100);
    const result = await pool.query(
      `SELECT * FROM products
       WHERE shop_id=$1
         AND ($2='' OR barcode=$2)
         AND ($3='' OR name ILIKE '%' || $3 || '%' OR barcode ILIKE '%' || $3 || '%')
       ORDER BY id DESC`,
      [user.shop_id, barcode, search]
    );
    return send(res, 200, { success: true, products: result.rows });
  }

  if (method === "POST" && path === "/products") {
    if (!(await requirePermission(user, "can_manage_products"))) {
      return send(res, 403, { success: false, error: "اجازه مدیریت کالاها را ندارید." });
    }

    const name = clean(b.name);
    const cost = Number(b.cost_price ?? b.buy_price ?? 0);
    const price = Number(b.price ?? b.sell_price ?? 0);
    const quantity = Number(b.quantity ?? b.stock ?? 0);
    const barcode = clean(b.barcode, 100);

    if (!name || ![cost, price, quantity].every(Number.isFinite) || cost < 0 || price < 0 || quantity < 0) {
      return send(res, 400, { success: false, error: "اطلاعات کالا معتبر نیست." });
    }

    const result = await pool.query(
      `INSERT INTO products(shop_id,name,cost_price,price,quantity,barcode)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user.shop_id, name, cost, price, quantity, barcode || null]
    );
    return send(res, 201, { success: true, product: result.rows[0], message: "کالا اضافه شد." });
  }

  if (parts[0] === "products" && parts[1] && method === "PUT") {
    if (!(await requirePermission(user, "can_manage_products"))) {
      return send(res, 403, { success: false, error: "اجازه ویرایش کالاها را ندارید." });
    }

    const id = Number(parts[1]);
    const result = await pool.query(
      `UPDATE products SET
        name=COALESCE($1,name),
        cost_price=COALESCE($2,cost_price),
        price=COALESCE($3,price),
        quantity=COALESCE($4,quantity),
        barcode=COALESCE($5,barcode)
       WHERE id=$6 AND shop_id=$7 RETURNING *`,
      [
        b.name == null ? null : clean(b.name),
        b.cost_price == null ? null : Number(b.cost_price),
        b.price == null ? null : Number(b.price),
        b.quantity == null ? null : Number(b.quantity),
        b.barcode == null ? null : clean(b.barcode, 100),
        id,
        user.shop_id,
      ]
    );

    if (!result.rowCount) return send(res, 404, { success: false, error: "کالا پیدا نشد." });
    return send(res, 200, { success: true, product: result.rows[0] });
  }

  if (parts[0] === "products" && parts[1] && method === "DELETE") {
    if (!(await requirePermission(user, "can_manage_products"))) {
      return send(res, 403, { success: false, error: "اجازه حذف کالاها را ندارید." });
    }

    const result = await pool.query(
      "DELETE FROM products WHERE id=$1 AND shop_id=$2 RETURNING id",
      [Number(parts[1]), user.shop_id]
    );
    if (!result.rowCount) return send(res, 404, { success: false, error: "کالا پیدا نشد." });
    return send(res, 200, { success: true });
  }

  if ((path === "/buy" || path === "/sell") && method === "POST") {
    const isSell = path === "/sell";
    const permission = isSell ? "can_sell" : "can_buy";

    if (!(await requirePermission(user, permission))) {
      return send(res, 403, { success: false, error: "برای این عملیات اجازه ندارید." });
    }

    const productId = Number(b.product_id);
    const quantity = Number(b.quantity);
    const price = Number(b.price);

    if (!Number.isInteger(productId) || !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isFinite(price) || price < 0) {
      return send(res, 400, { success: false, error: "تعداد و قیمت معتبر وارد کنید." });
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
      const oldQuantity = Number(product.quantity || 0);

      if (isSell && oldQuantity < quantity) throw new Error("موجودی کالا کافی نیست.");

      const customerId = b.customer_id ? Number(b.customer_id) : null;
      const total = money(quantity * price);
      const paid = isSell ? Number(b.paid ?? total) : total;

      if (!Number.isFinite(paid) || paid < 0 || paid > total) {
        throw new Error("مبلغ پرداخت‌شده باید بین صفر و مبلغ کل باشد.");
      }
      if (!isSell && customerId) throw new Error("برای خرید کالا مشتری انتخاب نکنید.");
      if (isSell && paid < total && !customerId) {
        throw new Error("برای فروش قرضی، ابتدا مشتری را ثبت و انتخاب کنید.");
      }

      if (isSell && customerId) {
        const customer = await client.query(
          "SELECT id FROM customers WHERE id=$1 AND shop_id=$2",
          [customerId, user.shop_id]
        );
        if (!customer.rowCount) throw new Error("مشتری انتخاب‌شده پیدا نشد.");
      }

      const newQuantity = isSell ? oldQuantity - quantity : oldQuantity + quantity;
      const profit = isSell ? money((price - Number(product.cost_price || 0)) * quantity) : 0;

      await client.query(
        `UPDATE products SET quantity=$1,
         cost_price=CASE WHEN $2='buy' THEN $3 ELSE cost_price END,
         price=CASE WHEN $2='sell' THEN $3 ELSE price END
         WHERE id=$4 AND shop_id=$5`,
        [newQuantity, isSell ? "sell" : "buy", price, productId, user.shop_id]
      );

      const transaction = await client.query(
        `INSERT INTO transactions
         (shop_id,product_id,product_name,type,quantity,price,total,profit)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [user.shop_id, productId, product.name, isSell ? "sell" : "buy",
          quantity, price, total, profit]
      );

      let receipt = null;
      if (isSell) {
        const receiptNumber =
          `DY-${user.shop_id}-${Date.now()}-${crypto.randomInt(1000, 10000)}`;

        const savedReceipt = await client.query(
          `INSERT INTO sale_receipts
           (shop_id,transaction_id,receipt_number,customer_id,total,paid)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [user.shop_id, transaction.rows[0].id, receiptNumber, customerId, total, paid]
        );
        receipt = savedReceipt.rows[0];
      }

      await client.query("COMMIT");
      return send(res, 200, {
        success: true,
        message: isSell ? "فروش ثبت شد." : "خرید ثبت شد.",
        new_quantity: newQuantity,
        stock: newQuantity,
        total,
        profit,
        paid,
        debt: isSell ? money(total - paid) : 0,
        receipt,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return send(res, 400, { success: false, error: error.message || "عملیات انجام نشد." });
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

  if (method === "GET" && path === "/low-stock") {
    const rawThreshold = Number(queryOf(req, "threshold", "5"));
    const threshold = Number.isFinite(rawThreshold) ? Math.max(0, Math.min(rawThreshold, 100000)) : 5;

    const result = await pool.query(
      `SELECT * FROM products WHERE shop_id=$1 AND quantity <= $2
       ORDER BY quantity ASC, name ASC`,
      [user.shop_id, threshold]
    );
    return send(res, 200, {
      success: true,
      threshold,
      count: result.rowCount,
      products: result.rows,
    });
  }

  if (method === "GET" && path === "/customers") {
    const result = await pool.query(
      `SELECT c.*,
        COALESCE(r.total_sales,0) AS total_sales,
        COALESCE(r.total_paid,0) AS total_paid,
        COALESCE(p.repayments,0) AS repayments,
        GREATEST(COALESCE(r.total_sales,0)-COALESCE(r.total_paid,0)-COALESCE(p.repayments,0),0) AS debt
       FROM customers c
       LEFT JOIN (
         SELECT customer_id,SUM(total) AS total_sales,SUM(paid) AS total_paid
         FROM sale_receipts WHERE shop_id=$1 AND customer_id IS NOT NULL GROUP BY customer_id
       ) r ON r.customer_id=c.id
       LEFT JOIN (
         SELECT customer_id,SUM(amount) AS repayments
         FROM customer_payments WHERE shop_id=$1 GROUP BY customer_id
       ) p ON p.customer_id=c.id
       WHERE c.shop_id=$1 ORDER BY c.id DESC`,
      [user.shop_id]
    );
    return send(res, 200, { success: true, customers: result.rows });
  }

  if (method === "POST" && path === "/customers") {
    const name = clean(b.name);
    const phone = clean(b.phone, 50);
    if (!name) return send(res, 400, { success: false, error: "نام مشتری را وارد کنید." });

    const result = await pool.query(
      "INSERT INTO customers(shop_id,name,phone) VALUES($1,$2,$3) RETURNING *",
      [user.shop_id, name, phone]
    );
    return send(res, 201, { success: true, customer: result.rows[0] });
  }

  if (parts[0] === "customers" && parts[1] && parts[2] === "payments" && method === "POST") {
    const customerId = Number(parts[1]);
    const amount = Number(b.amount);

    if (!Number.isInteger(customerId) || !Number.isFinite(amount) || amount <= 0) {
      return send(res, 400, { success: false, error: "مبلغ پرداخت معتبر نیست." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const customer = await client.query(
        "SELECT id FROM customers WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [customerId, user.shop_id]
      );
      if (!customer.rowCount) throw new Error("مشتری پیدا نشد.");

      const debtResult = await client.query(
        `SELECT
          COALESCE((SELECT SUM(total-paid) FROM sale_receipts
            WHERE shop_id=$1 AND customer_id=$2),0)
          - COALESCE((SELECT SUM(amount) FROM customer_payments
            WHERE shop_id=$1 AND customer_id=$2),0) AS debt`,
        [user.shop_id, customerId]
      );

      const debt = Math.max(0, Number(debtResult.rows[0].debt || 0));
      if (amount > debt) throw new Error(`مبلغ بیشتر از قرض باقی‌مانده است: ${money(debt)}`);

      const result = await client.query(
        `INSERT INTO customer_payments(shop_id,customer_id,amount,note)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [user.shop_id, customerId, money(amount), clean(b.note, 300)]
      );

      await client.query("COMMIT");
      return send(res, 201, {
        success: true,
        payment: result.rows[0],
        remaining_debt: money(debt - amount),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return send(res, 400, { success: false, error: error.message });
    } finally {
      client.release();
    }
  }

  if (method === "GET" && path === "/expenses") {
    const result = await pool.query(
      "SELECT * FROM shop_expenses WHERE shop_id=$1 ORDER BY id DESC LIMIT 500",
      [user.shop_id]
    );
    return send(res, 200, { success: true, expenses: result.rows });
  }

  if (method === "POST" && path === "/expenses") {
    const title = clean(b.title);
    const amount = Number(b.amount);
    if (!title || !Number.isFinite(amount) || amount <= 0) {
      return send(res, 400, { success: false, error: "عنوان مصرف و مبلغ درست وارد کنید." });
    }

    const result = await pool.query(
      `INSERT INTO shop_expenses(shop_id,title,amount,note)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [user.shop_id, title, money(amount), clean(b.note, 500)]
    );
    return send(res, 201, { success: true, expense: result.rows[0] });
  }

  if (method === "GET" && path === "/reports") {
    if (!(await requirePermission(user, "can_view_reports"))) {
      return send(res, 403, { success: false, error: "اجازه دیدن گزارش‌ها را ندارید." });
    }

    const result = await pool.query(
      `SELECT
        COALESCE((SELECT SUM(total) FROM transactions WHERE shop_id=$1 AND type='sell'),0) AS sales,
        COALESCE((SELECT SUM(total) FROM transactions WHERE shop_id=$1 AND type='buy'),0) AS purchases,
        COALESCE((SELECT SUM(profit) FROM transactions WHERE shop_id=$1 AND type='sell'),0) AS gross_profit,
        COALESCE((SELECT SUM(amount) FROM shop_expenses WHERE shop_id=$1),0) AS expenses,
        COALESCE((SELECT SUM(quantity*cost_price) FROM products WHERE shop_id=$1),0) AS stock_cost`,
      [user.shop_id]
    );

    const r = result.rows[0];
    const grossProfit = Number(r.gross_profit || 0);
    const expenses = Number(r.expenses || 0);

    return send(res, 200, {
      success: true,
      report: {
        sales: Number(r.sales),
        purchases: Number(r.purchases),
        gross_profit: grossProfit,
        expenses,
        net_profit: money(grossProfit - expenses),
        stock_cost: Number(r.stock_cost),
      },
    });
  }

  if (method === "GET" && path === "/receipts") {
    const result = await pool.query(
      `SELECT r.*,c.name AS customer_name,c.phone AS customer_phone
       FROM sale_receipts r LEFT JOIN customers c ON c.id=r.customer_id
       WHERE r.shop_id=$1 ORDER BY r.id DESC LIMIT 300`,
      [user.shop_id]
    );
    return send(res, 200, { success: true, receipts: result.rows });
  }

  if (parts[0] === "receipts" && parts[1] && method === "GET") {
    const result = await pool.query(
      `SELECT r.*,c.name AS customer_name,c.phone AS customer_phone,
              t.product_name,t.quantity,t.price,t.profit
       FROM sale_receipts r
       LEFT JOIN customers c ON c.id=r.customer_id
       LEFT JOIN transactions t ON t.id=r.transaction_id
       WHERE r.shop_id=$1 AND r.id=$2`,
      [user.shop_id, Number(parts[1])]
    );
    if (!result.rowCount) return send(res, 404, { success: false, error: "رسید پیدا نشد." });
    return send(res, 200, { success: true, receipt: result.rows[0] });
  }

  if (method === "GET" && path === "/workers") {
    if (!(await requirePermission(user, "can_manage_workers"))) {
      return send(res, 403, { success: false, error: "اجازه مدیریت کارمندان را ندارید." });
    }

    const result = await pool.query(
      `SELECT u.id,u.username,u.email,u.full_name,u.role,u.created_at,
              p.can_sell,p.can_buy,p.can_manage_products,p.can_view_reports,p.can_manage_workers
       FROM users u LEFT JOIN worker_permissions p
         ON p.user_id=u.id AND p.shop_id=u.shop_id
       WHERE u.shop_id=$1 AND u.role='worker' ORDER BY u.id DESC`,
      [user.shop_id]
    );
    return send(res, 200, { success: true, workers: result.rows });
  }

  if (method === "POST" && path === "/workers") {
    if (!(await requirePermission(user, "can_manage_workers"))) {
      return send(res, 403, { success: false, error: "فقط صاحب دوکان اجازه مدیریت کارمندان را دارد." });
    }

    const email = clean(b.email || b.username, 254).toLowerCase();
    const name = clean(b.full_name || b.name);
    const password = String(b.password || "");

    if (!validEmail(email) || password.length < 8) {
      return send(res, 400, { success: false, error: "ایمیل معتبر و رمز حداقل ۸ حرفی وارد کنید." });
    }

    const duplicate = await pool.query(
      "SELECT id FROM users WHERE LOWER(username)=LOWER($1)",
      [email]
    );
    if (duplicate.rowCount) {
      return send(res, 409, { success: false, error: "این ایمیل قبلاً ثبت شده است." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO users
         (shop_id,username,email,password_hash,full_name,role,email_verified)
         VALUES($1,$2,$2,$3,$4,'worker',TRUE)
         RETURNING id,username,email,full_name,role`,
        [user.shop_id, email, hash(password), name]
      );

      const worker = result.rows[0];
      await client.query(
        `INSERT INTO worker_permissions
         (user_id,shop_id,can_sell,can_buy,can_manage_products,can_view_reports,can_manage_workers)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          worker.id, user.shop_id,
          b.can_sell !== false,
          b.can_buy === true,
          b.can_manage_products === true,
          b.can_view_reports === true,
          false,
        ]
      );

      await client.query("COMMIT");
      return send(res, 201, { success: true, worker, message: "کارمند اضافه شد." });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        return send(res, 409, { success: false, error: "این ایمیل قبلاً ثبت شده است." });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  if (parts[0] === "workers" && parts[1] && parts[2] === "permissions" && method === "PUT") {
    if (user.role !== "owner" && user.role !== "admin") {
      return send(res, 403, { success: false, error: "اجازه تغییر دسترسی را ندارید." });
    }

    const workerId = Number(parts[1]);
    const result = await pool.query(
      `UPDATE worker_permissions SET
        can_sell=$1, can_buy=$2, can_manage_products=$3,
        can_view_reports=$4, can_manage_workers=FALSE
       WHERE user_id=$5 AND shop_id=$6
       RETURNING *`,
      [
        b.can_sell === true,
        b.can_buy === true,
        b.can_manage_products === true,
        b.can_view_reports === true,
        workerId,
        user.shop_id,
      ]
    );
    if (!result.rowCount) return send(res, 404, { success: false, error: "دسترسی کارمند پیدا نشد." });
    return send(res, 200, { success: true, permissions: result.rows[0] });
  }

  if (parts[0] === "workers" && parts[1] && method === "DELETE") {
    if (!(await requirePermission(user, "can_manage_workers"))) {
      return send(res, 403, { success: false, error: "اجازه حذف کارمند را ندارید." });
    }
    const id = Number(parts[1]);
    if (id === user.id) {
      return send(res, 400, { success: false, error: "حساب خودتان را نمی‌توانید حذف کنید." });
    }

    const result = await pool.query(
      "DELETE FROM users WHERE id=$1 AND shop_id=$2 AND role='worker' RETURNING id",
      [id, user.shop_id]
    );
    if (!result.rowCount) return send(res, 404, { success: false, error: "کارمند پیدا نشد." });
    return send(res, 200, { success: true });
  }

  if (method === "GET" && path === "/shop") {
    return send(res, 200, {
      success: true,
      shop: { id: user.shop_id, name: user.shop_name, owner_name: user.owner_name },
    });
  }

  if (method === "PUT" && path === "/shop") {
    if (user.role !== "owner" && user.role !== "admin") {
      return send(res, 403, { success: false, error: "فقط صاحب دوکان می‌تواند مشخصات دوکان را تغییر دهد." });
    }

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

  if (method === "GET" && path === "/backup") {
    if (user.role !== "owner" && user.role !== "admin") {
      return send(res, 403, { success: false, error: "فقط صاحب دوکان اجازه پشتیبان‌گیری دارد." });
    }

    const [shop, products, transactions, customers, payments, expenses, receipts] =
      await Promise.all([
        pool.query("SELECT id,name,owner_name,created_at FROM shops WHERE id=$1", [user.shop_id]),
        pool.query("SELECT * FROM products WHERE shop_id=$1 ORDER BY id", [user.shop_id]),
        pool.query("SELECT * FROM transactions WHERE shop_id=$1 ORDER BY id", [user.shop_id]),
        pool.query("SELECT * FROM customers WHERE shop_id=$1 ORDER BY id", [user.shop_id]),
        pool.query("SELECT * FROM customer_payments WHERE shop_id=$1 ORDER BY id", [user.shop_id]),
        pool.query("SELECT * FROM shop_expenses WHERE shop_id=$1 ORDER BY id", [user.shop_id]),
        pool.query("SELECT * FROM sale_receipts WHERE shop_id=$1 ORDER BY id", [user.shop_id]),
      ]);

    return send(res, 200, {
      success: true,
      backup: {
        version: 1,
        exported_at: new Date().toISOString(),
        shop: shop.rows,
        products: products.rows,
        transactions: transactions.rows,
        customers: customers.rows,
        customer_payments: payments.rows,
        expenses: expenses.rows,
        receipts: receipts.rows,
      },
    });
  }

  if (method === "POST" && path === "/admin/approve-payment") {
    const adminKey = process.env.DOKANYAAR_ADMIN_KEY;
    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return send(res, 403, { success: false, error: "دسترسی مدیر رد شد." });
    }

    const paymentId = Number(b.payment_id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const payment = await client.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [paymentId]);
      if (!payment.rowCount) throw new Error("درخواست پرداخت پیدا نشد.");

      const p = payment.rows[0];
      if (p.status !== "pending") throw new Error("این پرداخت قبلاً بررسی شده است.");

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
      return send(res, 200, { success: true, message: "پرداخت تأیید و حساب فعال شد." });
    } catch (error) {
      await client.query("ROLLBACK");
      return send(res, 400, { success: false, error: error.message });
    } finally {
      client.release();
    }
  }

  if (method === "GET" && path === "/admin/pending-payments") {
    const adminKey = process.env.DOKANYAAR_ADMIN_KEY;
    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return send(res, 403, { success: false, error: "دسترسی مدیر رد شد." });
    }

    const result = await pool.query(
      `SELECT p.*,s.name AS shop_name,u.email
       FROM payments p
       LEFT JOIN shops s ON s.id=p.shop_id
       LEFT JOIN users u ON u.id=p.user_id
       WHERE p.status='pending' ORDER BY p.id DESC`
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
  ).split(",").map((x) => x.trim());

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Auth-Token, X-Admin-Key"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

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
