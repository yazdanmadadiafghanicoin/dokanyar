const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING,
  ssl: { rejectUnauthorized: false },
});

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  return res.end(JSON.stringify(data));
}

function send(res, data) {
  return json(res, 200, data);
}

function error(res, message, status) {
  return json(res, status || 400, {
    success: false,
    error: message,
  });
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("JSON نامعتبر است"));
      }
    });

    req.on("error", reject);
  });
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

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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
      username TEXT DEFAULT '',
      email TEXT,
      password TEXT,
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code TEXT
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_attempts INTEGER DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_verification_sent TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token TEXT
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
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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

  await pool.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'AFN'
  `);

  await pool.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency_rate NUMERIC(18,6) DEFAULT 1
  `);

  await pool.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,2) DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS base_total NUMERIC(18,2) DEFAULT 0
  `);

  await pool.query(`
    UPDATE transactions
    SET currency = 'AFN'
    WHERE currency IS NULL
  `);

  await pool.query(`
    UPDATE transactions
    SET currency_rate = 1
    WHERE currency_rate IS NULL OR currency_rate = 0
  `);

  await pool.query(`
    UPDATE transactions
    SET base_unit_price = unit_price
    WHERE base_unit_price IS NULL OR base_unit_price = 0
  `);

  await pool.query(`
    UPDATE transactions
    SET base_total = total
    WHERE base_total IS NULL OR base_total = 0
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS users_email_idx ON users(email)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS users_token_idx ON users(token)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS products_shop_idx ON products(shop_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS transactions_shop_idx
    ON transactions(shop_id)
  `);

  return true;
}

async function getUser(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const token = auth.substring(7).trim();

  if (!token) return null;

  const result = await pool.query(
    `SELECT * FROM users WHERE token = $1 LIMIT 1`,
    [token]
  );

  if (!result.rows.length) return null;

  return result.rows[0];
}

async function requireUser(req, res) {
  const user = await getUser(req);

  if (!user) {
    error(res, "لطفاً وارد حساب شوید.", 401);
    return null;
  }

  return user;
}

async function sendVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY در Vercel تنظیم نشده است.");
  }

  const from =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: from,
      to: [email],
      subject: "کد تأیید ثبت‌نام دوکان‌یار",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
          <h2>دوکان‌یار</h2>
          <p>کد تأیید ایمیل شما:</p>

          <div style="
            font-size:34px;
            font-weight:bold;
            letter-spacing:8px;
            padding:20px;
            background:#f3f4f6;
            text-align:center;
            border-radius:12px;
          ">
            ${code}
          </div>

          <p>این کد تا ۱۰ دقیقه اعتبار دارد.</p>
          <p>اگر شما این درخواست را انجام نداده‌اید، این ایمیل را نادیده بگیرید.</p>
        </div>
      `,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error("ارسال ایمیل ناموفق بود: " + text);
  }

  return true;
}

async function register(req, res) {
  const b = await body(req);

  const shopName = String(
    b.shop_name || b.shopName || b.name || ""
  ).trim();

  const username = String(
    b.username || b.owner_name || b.ownerName || ""
  ).trim();

  const email = normalizeEmail(b.email);

  const password = String(b.password || "");

  if (!shopName) {
    return error(res, "نام دوکان را وارد کنید.");
  }

  if (!email || !validEmail(email)) {
    return error(res, "ایمیل معتبر وارد کنید.");
  }

  if (password.length < 6) {
    return error(res, "رمز عبور باید حداقل ۶ حرف باشد.");
  }

  const existing = await pool.query(
    `SELECT id, email_verified FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email]
  );

  let shopId;
  let userId;

  if (existing.rows.length && existing.rows[0].email_verified) {
    return error(res, "این ایمیل قبلاً ثبت‌نام شده است.");
  }

  if (existing.rows.length && !existing.rows[0].email_verified) {
    userId = existing.rows[0].id;

    const u = await pool.query(
      `SELECT shop_id FROM users WHERE id = $1`,
      [userId]
    );

    shopId = u.rows[0].shop_id;
  } else {
    const shop = await pool.query(
      `INSERT INTO shops(name) VALUES($1) RETURNING id`,
      [shopName]
    );

    shopId = shop.rows[0].id;

    const user = await pool.query(
      `
      INSERT INTO users
      (shop_id, username, email, password, role, email_verified)
      VALUES($1,$2,$3,$4,'owner',FALSE)
      RETURNING id
      `,
      [
        shopId,
        username || email.split("@")[0],
        email,
        hashPassword(password),
      ]
    );

    userId = user.rows[0].id;
  }

  const code = verificationCode();

  await pool.query(
    `
    UPDATE users
    SET
      username = $1,
      email = $2,
      password = $3,
      verification_code = $4,
      verification_expires = NOW() + INTERVAL '10 minutes',
      verification_attempts = 0,
      last_verification_sent = NOW()
    WHERE id = $5
    `,
    [
      username || email.split("@")[0],
      email,
      hashPassword(password),
      code,
      userId,
    ]
  );

  try {
    await sendVerificationEmail(email, code);
  } catch (e) {
    return error(res, e.message, 500);
  }

  return send(res, {
    success: true,
    verification_required: true,
    message: "کد تأیید به ایمیل شما ارسال شد.",
    email: email,
  });
}

async function verifyEmail(req, res) {
  const b = await body(req);

  const email = normalizeEmail(b.email);
  const code = String(
    b.code || b.verification_code || ""
  ).trim();

  if (!email || !validEmail(email)) {
    return error(res, "ایمیل معتبر وارد کنید.");
  }

  if (!/^\d{6}$/.test(code)) {
    return error(res, "کد تأیید باید ۶ رقمی باشد.");
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email]
  );

  if (!result.rows.length) {
    return error(res, "حساب پیدا نشد.");
  }

  const user = result.rows[0];

  if (user.email_verified) {
    return send(res, {
      success: true,
      message: "ایمیل قبلاً تأیید شده است.",
    });
  }

  if (
    user.verification_expires &&
    new Date(user.verification_expires).getTime() < Date.now()
  ) {
    return error(res, "کد منقضی شده است. کد جدید درخواست کنید.");
  }

  const attempts = Number(user.verification_attempts || 0);

  if (attempts >= 5) {
    return error(
      res,
      "تعداد تلاش زیاد است. کد جدید درخواست کنید."
    );
  }

  if (user.verification_code !== code) {
    await pool.query(
      `
      UPDATE users
      SET verification_attempts = verification_attempts + 1
      WHERE id = $1
      `,
      [user.id]
    );

    return error(res, "کد تأیید اشتباه است.");
  }

  const token = randomToken();

  await pool.query(
    `
    UPDATE users
    SET
      email_verified = TRUE,
      verification_code = NULL,
      verification_expires = NULL,
      verification_attempts = 0,
      token = $1
    WHERE id = $2
    `,
    [token, user.id]
  );

  return send(res, {
    success: true,
    verified: true,
    token: token,
    message: "ایمیل با موفقیت تأیید شد.",
  });
}

async function resendVerification(req, res) {
  const b = await body(req);

  const email = normalizeEmail(b.email);

  if (!email || !validEmail(email)) {
    return error(res, "ایمیل معتبر وارد کنید.");
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email]
  );

  if (!result.rows.length) {
    return error(res, "حساب پیدا نشد.");
  }

  const user = result.rows[0];

  if (user.email_verified) {
    return error(res, "این ایمیل قبلاً تأیید شده است.");
  }

  if (user.last_verification_sent) {
    const last = new Date(
      user.last_verification_sent
    ).getTime();

    if (Date.now() - last < 60 * 1000) {
      return error(
        res,
        "لطفاً حداقل ۶۰ ثانیه برای ارسال کد جدید صبر کنید."
      );
    }
  }

  const code = verificationCode();

  await pool.query(
    `
    UPDATE users
    SET
      verification_code = $1,
      verification_expires = NOW() + INTERVAL '10 minutes',
      verification_attempts = 0,
      last_verification_sent = NOW()
    WHERE id = $2
    `,
    [code, user.id]
  );

  try {
    await sendVerificationEmail(email, code);
  } catch (e) {
    return error(res, e.message, 500);
  }

  return send(res, {
    success: true,
    message: "کد جدید به ایمیل ارسال شد.",
  });
}

async function login(req, res) {
  const b = await body(req);

  const email = normalizeEmail(b.email);
  const password = String(b.password || "");

  if (!email || !validEmail(email)) {
    return error(res, "ایمیل معتبر وارد کنید.");
  }

  if (!password) {
    return error(res, "رمز عبور را وارد کنید.");
  }

  const result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [email]
  );

  if (!result.rows.length) {
    return error(res, "ایمیل یا رمز عبور اشتباه است.");
  }

  const user = result.rows[0];

  if (user.password !== hashPassword(password)) {
    return error(res, "ایمیل یا رمز عبور اشتباه است.");
  }

  if (!user.email_verified) {
    return send(res, {
      success: false,
      verification_required: true,
      email: email,
      message: "ابتدا ایمیل خود را تأیید کنید.",
    });
  }

  const token = randomToken();

  await pool.query(
    `UPDATE users SET token = $1 WHERE id = $2`,
    [token, user.id]
  );

  return send(res, {
    success: true,
    token: token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      shop_id: user.shop_id,
    },
  });
}

async function logout(req, res) {
  const user = await getUser(req);

  if (user) {
    await pool.query(
      `UPDATE users SET token = NULL WHERE id = $1`,
      [user.id]
    );
  }

  return send(res, {
    success: true,
    message: "خارج شدید.",
  });
}

async function me(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  const shop = await pool.query(
    `SELECT * FROM shops WHERE id = $1`,
    [user.shop_id]
  );

  return send(res, {
    success: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      shop_id: user.shop_id,
      email_verified: user.email_verified,
    },
    shop: shop.rows[0] || null,
  });
}

async function products(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  const result = await pool.query(
    `
    SELECT *
    FROM products
    WHERE shop_id = $1
    ORDER BY id DESC
    `,
    [user.shop_id]
  );

  return send(res, {
    success: true,
    products: result.rows,
    count: result.rows.length,
  });
}

async function createProduct(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  const b = await body(req);

  const name = String(b.name || "").trim();
  const brand = String(b.brand || "").trim();
  const model = String(b.model || "").trim();
  const buyPrice = Number(
    b.buy_price !== undefined ? b.buy_price : b.buyPrice
  ) || 0;
  const sellPrice = Number(
    b.sell_price !== undefined ? b.sell_price : b.sellPrice
  ) || 0;
  const quantity = Number(b.quantity) || 0;

  if (!name) {
    return error(res, "نام جنس را وارد کنید.");
  }

  const result = await pool.query(
    `
    INSERT INTO products
    (shop_id,name,brand,model,buy_price,sell_price,quantity)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
    `,
    [
      user.shop_id,
      name,
      brand,
      model,
      buyPrice,
      sellPrice,
      quantity,
    ]
  );

  return send(res, {
    success: true,
    product: result.rows[0],
  });
}

async function updateProduct(req, res, id) {
  const user = await requireUser(req, res);

  if (!user) return;

  const b = await body(req);

  const result = await pool.query(
    `
    UPDATE products
    SET
      name = COALESCE($1,name),
      brand = COALESCE($2,brand),
      model = COALESCE($3,model),
      sell_price = COALESCE($4,sell_price)
    WHERE id = $5 AND shop_id = $6
    RETURNING *
    `,
    [
      b.name || null,
      b.brand || null,
      b.model || null,
      b.sell_price !== undefined
        ? Number(b.sell_price)
        : null,
      id,
      user.shop_id,
    ]
  );

  if (!result.rows.length) {
    return error(res, "جنس پیدا نشد.", 404);
  }

  return send(res, {
    success: true,
    product: result.rows[0],
  });
}

async function deleteProduct(req, res, id) {
  const user = await requireUser(req, res);

  if (!user) return;

  const result = await pool.query(
    `
    DELETE FROM products
    WHERE id = $1 AND shop_id = $2
    RETURNING id
    `,
    [id, user.shop_id]
  );

  if (!result.rows.length) {
    return error(res, "جنس پیدا نشد.", 404);
  }

  return send(res, {
    success: true,
    message: "جنس حذف شد.",
  });
}

function transactionCurrency(b) {
  const currency = String(
    b.currency || "AFN"
  ).toUpperCase();

  if (currency !== "AFN" && currency !== "USD") {
    return null;
  }

  return currency;
}

function transactionRate(b, currency) {
  if (currency === "AFN") return 1;

  const rate = Number(
    b.currency_rate !== undefined
      ? b.currency_rate
      : b.rate
  );

  if (!rate || rate <= 0) return null;

  return rate;
}

async function buy(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  const b = await body(req);

  const productId = Number(
    b.product_id !== undefined
      ? b.product_id
      : b.productId
  );

  const quantity = Number(b.quantity);

  const unitPrice = Number(
    b.unit_price !== undefined
      ? b.unit_price
      : b.unitPrice
  );

  const currency = transactionCurrency(b);

  if (!productId || !quantity || quantity <= 0) {
    return error(res, "مقدار خرید درست نیست.");
  }

  if (!unitPrice || unitPrice < 0) {
    return error(res, "قیمت خرید درست نیست.");
  }

  if (!currency) {
    return error(res, "واحد پول باید AFN یا USD باشد.");
  }

  const rate = transactionRate(b, currency);

  if (!rate) {
    return error(
      res,
      "برای خرید دالری نرخ تبدیل AFN/USD را وارد کنید."
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `
      SELECT *
      FROM products
      WHERE id = $1 AND shop_id = $2
      FOR UPDATE
      `,
      [productId, user.shop_id]
    );

    if (!productResult.rows.length) {
      await client.query("ROLLBACK");
      return error(res, "جنس پیدا نشد.", 404);
    }

    const product = productResult.rows[0];

    const oldQty = Number(product.quantity) || 0;
    const oldBuy = Number(product.buy_price) || 0;

    const baseUnitPrice =
      currency === "USD"
        ? unitPrice * rate
        : unitPrice;

    const total = quantity * unitPrice;
    const baseTotal = quantity * baseUnitPrice;

    const newQty = oldQty + quantity;

    const newAverage =
      newQty > 0
        ? ((oldQty * oldBuy) + baseTotal) / newQty
        : baseUnitPrice;

    await client.query(
      `
      UPDATE products
      SET
        quantity = $1,
        buy_price = $2
      WHERE id = $3 AND shop_id = $4
      `,
      [
        newQty,
        newAverage,
        productId,
        user.shop_id,
      ]
    );

    const transaction = await client.query(
      `
      INSERT INTO transactions
      (
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
      VALUES
      ($1,$2,$3,'buy',$4,$5,$6,$7,0,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        user.shop_id,
        productId,
        user.id,
        quantity,
        unitPrice,
        total,
        baseTotal,
        currency,
        rate,
        baseUnitPrice,
        baseTotal,
      ]
    );

    await client.query("COMMIT");

    return send(res, {
      success: true,
      message: "خرید ثبت شد.",
      transaction: transaction.rows[0],
      receipt: {
        type: "buy",
        product: product.name,
        quantity: quantity,
        unit_price: unitPrice,
        total: total,
        currency: currency,
        currency_rate: rate,
        base_total_afn: baseTotal,
        average_buy_price_afn: newAverage,
      },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    return error(res, e.message, 500);
  } finally {
    client.release();
  }
}

async function sell(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  const b = await body(req);

  const productId = Number(
    b.product_id !== undefined
      ? b.product_id
      : b.productId
  );

  const quantity = Number(b.quantity);

  const unitPrice = Number(
    b.unit_price !== undefined
      ? b.unit_price
      : b.unitPrice
  );

  const currency = transactionCurrency(b);

  if (!productId || !quantity || quantity <= 0) {
    return error(res, "مقدار فروش درست نیست.");
  }

  if (!unitPrice || unitPrice < 0) {
    return error(res, "قیمت فروش درست نیست.");
  }

  if (!currency) {
    return error(res, "واحد پول باید AFN یا USD باشد.");
  }

  const rate = transactionRate(b, currency);

  if (!rate) {
    return error(
      res,
      "برای فروش دالری نرخ تبدیل AFN/USD را وارد کنید."
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `
      SELECT *
      FROM products
      WHERE id = $1 AND shop_id = $2
      FOR UPDATE
      `,
      [productId, user.shop_id]
    );

    if (!productResult.rows.length) {
      await client.query("ROLLBACK");
      return error(res, "جنس پیدا نشد.", 404);
    }

    const product = productResult.rows[0];

    const stock = Number(product.quantity) || 0;

    if (stock < quantity) {
      await client.query("ROLLBACK");

      return error(
        res,
        "موجودی کافی نیست. موجودی فعلی: " + stock
      );
    }

    const buyPriceAFN =
      Number(product.buy_price) || 0;

    const baseUnitPrice =
      currency === "USD"
        ? unitPrice * rate
        : unitPrice;

    const total = quantity * unitPrice;

    const baseTotal =
      quantity * baseUnitPrice;

    const buyCost =
      quantity * buyPriceAFN;

    const profit =
      baseTotal - buyCost;

    const newStock =
      stock - quantity;

    await client.query(
      `
      UPDATE products
      SET quantity = $1
      WHERE id = $2 AND shop_id = $3
      `,
      [
        newStock,
        productId,
        user.shop_id,
      ]
    );

    const transaction = await client.query(
      `
      INSERT INTO transactions
      (
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
      VALUES
      ($1,$2,$3,'sell',$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
      `,
      [
        user.shop_id,
        productId,
        user.id,
        quantity,
        unitPrice,
        total,
        buyCost,
        profit,
        currency,
        rate,
        baseUnitPrice,
        baseTotal,
      ]
    );

    await client.query("COMMIT");

    return send(res, {
      success: true,
      message: "فروش ثبت شد.",
      transaction: transaction.rows[0],
      receipt: {
        type: "sell",
        product: product.name,
        quantity: quantity,
        unit_price: unitPrice,
        total: total,
        currency: currency,
        currency_rate: rate,
        base_total_afn: baseTotal,
        buy_cost_afn: buyCost,
        profit_afn: profit,
        remaining_stock: newStock,
      },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    return error(res, e.message, 500);
  } finally {
    client.release();
  }
}

async function transactions(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  const result = await pool.query(
    `
    SELECT
      t.*,
      p.name AS product_name,
      u.username
    FROM transactions t
    LEFT JOIN products p ON p.id = t.product_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.shop_id = $1
    ORDER BY t.id DESC
    LIMIT 500
    `,
    [user.shop_id]
  );

  return send(res, {
    success: true,
    transactions: result.rows,
  });
}

async function transactionById(req, res, id) {
  const user = await requireUser(req, res);

  if (!user) return;

  const result = await pool.query(
    `
    SELECT
      t.*,
      p.name AS product_name,
      u.username
    FROM transactions t
    LEFT JOIN products p ON p.id = t.product_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.id = $1 AND t.shop_id = $2
    LIMIT 1
    `,
    [id, user.shop_id]
  );

  if (!result.rows.length) {
    return error(res, "رسید پیدا نشد.", 404);
  }

  return send(res, {
    success: true,
    transaction: result.rows[0],
  });
}

async function dashboard(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  const sales = await pool.query(
    `
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(base_total),0) AS total_afn,
      COALESCE(SUM(profit),0) AS profit_afn
    FROM transactions
    WHERE shop_id = $1 AND type = 'sell'
    `,
    [user.shop_id]
  );

  const purchases = await pool.query(
    `
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(base_total),0) AS total_afn
    FROM transactions
    WHERE shop_id = $1 AND type = 'buy'
    `,
    [user.shop_id]
  );

  const stock = await pool.query(
    `
    SELECT
      COUNT(*) AS products,
      COALESCE(SUM(quantity),0) AS quantity
    FROM products
    WHERE shop_id = $1
    `,
    [user.shop_id]
  );

  const salesCurrency = await pool.query(
    `
    SELECT
      currency,
      COUNT(*) AS count,
      COALESCE(SUM(total),0) AS total
    FROM transactions
    WHERE shop_id = $1 AND type = 'sell'
    GROUP BY currency
    `,
    [user.shop_id]
  );

  const purchaseCurrency = await pool.query(
    `
    SELECT
      currency,
      COUNT(*) AS count,
      COALESCE(SUM(total),0) AS total
    FROM transactions
    WHERE shop_id = $1 AND type = 'buy'
    GROUP BY currency
    `,
    [user.shop_id]
  );

  return send(res, {
    success: true,

    dashboard: {
      sales_count: Number(sales.rows[0].count || 0),
      sales_total_afn: Number(
        sales.rows[0].total_afn || 0
      ),
      profit_afn: Number(
        sales.rows[0].profit_afn || 0
      ),

      purchases_count: Number(
        purchases.rows[0].count || 0
      ),
      purchases_total_afn: Number(
        purchases.rows[0].total_afn || 0
      ),

      products_count: Number(
        stock.rows[0].products || 0
      ),

      stock_quantity: Number(
        stock.rows[0].quantity || 0
      ),

      sales_by_currency: salesCurrency.rows,
      purchases_by_currency: purchaseCurrency.rows,
    },
  });
}

async function workers(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  if (req.method === "GET") {
    const result = await pool.query(
      `
      SELECT
        id,
        username,
        email,
        role,
        email_verified,
        created_at
      FROM users
      WHERE shop_id = $1
      ORDER BY id DESC
      `,
      [user.shop_id]
    );

    return send(res, {
      success: true,
      workers: result.rows,
    });
  }

  if (req.method === "POST") {
    if (user.role !== "owner") {
      return error(
        res,
        "فقط صاحب دوکان می‌تواند کاربر اضافه کند.",
        403
      );
    }

    const b = await body(req);

    const email = normalizeEmail(b.email);
    const username = String(
      b.username || ""
    ).trim();

    const password = String(
      b.password || ""
    );

    if (!email || !validEmail(email)) {
      return error(res, "ایمیل معتبر وارد کنید.");
    }

    if (password.length < 6) {
      return error(
        res,
        "رمز عبور باید حداقل ۶ حرف باشد."
      );
    }

    const exists = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = $1`,
      [email]
    );

    if (exists.rows.length) {
      return error(res, "این ایمیل قبلاً استفاده شده است.");
    }

    const result = await pool.query(
      `
      INSERT INTO users
      (shop_id,username,email,password,role,email_verified)
      VALUES($1,$2,$3,$4,'worker',TRUE)
      RETURNING id,username,email,role
      `,
      [
        user.shop_id,
        username || email.split("@")[0],
        email,
        hashPassword(password),
      ]
    );

    return send(res, {
      success: true,
      worker: result.rows[0],
    });
  }

  return error(res, "Method not allowed", 405);
}

async function deleteWorker(req, res, id) {
  const user = await requireUser(req, res);

  if (!user) return;

  if (user.role !== "owner") {
    return error(
      res,
      "فقط صاحب دوکان می‌تواند کاربر حذف کند.",
      403
    );
  }

  const result = await pool.query(
    `
    DELETE FROM users
    WHERE id = $1
      AND shop_id = $2
      AND role = 'worker'
    RETURNING id
    `,
    [id, user.shop_id]
  );

  if (!result.rows.length) {
    return error(res, "کاربر پیدا نشد.", 404);
  }

  return send(res, {
    success: true,
    message: "کاربر حذف شد.",
  });
}

async function shop(req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  if (req.method === "GET") {
    const result = await pool.query(
      `SELECT * FROM shops WHERE id = $1`,
      [user.shop_id]
    );

    return send(res, {
      success: true,
      shop: result.rows[0] || null,
    });
  }

  if (req.method === "PUT") {
    const b = await body(req);

    const result = await pool.query(
      `
      UPDATE shops
      SET
        name = COALESCE($1,name),
        phone = COALESCE($2,phone),
        address = COALESCE($3,address)
      WHERE id = $4
      RETURNING *
      `,
      [
        b.name || null,
        b.phone || null,
        b.address || null,
        user.shop_id,
      ]
    );

    return send(res, {
      success: true,
      shop: result.rows[0],
    });
  }

  return error(res, "Method not allowed", 405);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    return res.end();
  }

  try {
    await setupDatabase();

    let path = req.query && req.query.path;

    if (Array.isArray(path)) {
      path = path.join("/");
    }

    path = String(path || "").replace(/^\/+|\/+$/g, "");

    if (!path) {
      return send(res, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: true,
        email_verification: true,
      });
    }

    if (path === "setup") {
      return send(res, {
        success: true,
        message: "Database setup completed.",
        database: true,
      });
    }

    if (path === "register" && req.method === "POST") {
      return await register(req, res);
    }

    if (
      path === "verify-email" &&
      req.method === "POST"
    ) {
      return await verifyEmail(req, res);
    }

    if (
      path === "verify" &&
      req.method === "POST"
    ) {
      return await verifyEmail(req, res);
    }

    if (
      path === "resend-code" &&
      req.method === "POST"
    ) {
      return await resendVerification(req, res);
    }

    if (
      path === "resend-verification" &&
      req.method === "POST"
    ) {
      return await resendVerification(req, res);
    }

    if (path === "login" && req.method === "POST") {
      return await login(req, res);
    }

    if (path === "logout" && req.method === "POST") {
      return await logout(req, res);
    }

    if (path === "me" && req.method === "GET") {
      return await me(req, res);
    }

    if (path === "products") {
      if (req.method === "GET") {
        return await products(req, res);
      }

      if (req.method === "POST") {
        return await createProduct(req, res);
      }
    }

    if (path.startsWith("products/")) {
      const id = path.split("/")[1];

      if (req.method === "PUT") {
        return await updateProduct(req, res, id);
      }

      if (req.method === "DELETE") {
        return await deleteProduct(req, res, id);
      }
    }

    if (path === "buy" && req.method === "POST") {
      return await buy(req, res);
    }

    if (path === "sell" && req.method === "POST") {
      return await sell(req, res);
    }

    if (
      path === "transactions" &&
      req.method === "GET"
    ) {
      return await transactions(req, res);
    }

    if (path.startsWith("transactions/")) {
      const id = path.split("/")[1];

      if (req.method === "GET") {
        return await transactionById(req, res, id);
      }
    }

    if (
      path === "dashboard" &&
      req.method === "GET"
    ) {
      return await dashboard(req, res);
    }

    if (path === "workers") {
      return await workers(req, res);
    }

    if (path.startsWith("workers/")) {
      const id = path.split("/")[1];

      if (req.method === "DELETE") {
        return await deleteWorker(req, res, id);
      }
    }

    if (path === "shop") {
      return await shop(req, res);
    }

    return error(
      res,
      "Endpoint not found: /api/" + path,
      404
    );
  } catch (e) {
    console.error(e);

    return json(res, 500, {
      success: false,
      error: e.message || "Server error",
    });
  }
};