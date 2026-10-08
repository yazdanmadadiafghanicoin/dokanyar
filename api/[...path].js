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

function headers(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function send(res, data, status = 200) {
  headers(res);
  res.status(status).json(data);
}

async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  return new Promise((resolve) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password || ""))
    .digest("hex");
}

function token() {
  return crypto.randomBytes(32).toString("hex");
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function currencyRate(currency, rate) {
  if (String(currency).toUpperCase() === "USD") {
    const r = number(rate, 0);
    return r > 0 ? r : 1;
  }

  return 1;
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
      password_hash TEXT DEFAULT '',
      role TEXT DEFAULT 'owner',
      token TEXT DEFAULT '',
      email_verified BOOLEAN DEFAULT FALSE,
      verification_code TEXT DEFAULT '',
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
      buy_price NUMERIC DEFAULT 0,
      sell_price NUMERIC DEFAULT 0,
      quantity NUMERIC DEFAULT 0,
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
      quantity NUMERIC DEFAULT 0,
      unit_price NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0,
      buy_cost NUMERIC DEFAULT 0,
      profit NUMERIC DEFAULT 0,
      currency TEXT DEFAULT 'AFN',
      currency_rate NUMERIC DEFAULT 1,
      base_unit_price NUMERIC DEFAULT 0,
      base_total NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  /* migrations */

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_code TEXT DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_attempts INTEGER DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_verification_sent TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'AFN'
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS currency_rate NUMERIC DEFAULT 1
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS base_total NUMERIC DEFAULT 0
  `);

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

  await pool.query(`
    UPDATE transactions
    SET
      currency = COALESCE(NULLIF(currency, ''), 'AFN'),
      currency_rate = COALESCE(currency_rate, 1),
      base_unit_price =
        CASE
          WHEN COALESCE(base_unit_price, 0) = 0
          THEN COALESCE(unit_price, 0) * COALESCE(currency_rate, 1)
          ELSE base_unit_price
        END,
      base_total =
        CASE
          WHEN COALESCE(base_total, 0) = 0
          THEN COALESCE(total, 0) * COALESCE(currency_rate, 1)
          ELSE base_total
        END
  `);

  return true;
}

/* =========================
   AUTH
========================= */

async function getUser(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const t = auth.substring(7).trim();

  if (!t) return null;

  const result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE token = $1
    LIMIT 1
    `,
    [t]
  );

  return result.rows[0] || null;
}

/* =========================
   EMAIL
========================= */

async function sendVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "RESEND_API_KEY تنظیم نشده است.",
    };
  }

  const from =
    process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "کد تأیید دوکان‌یار",
      html: `
        <div style="font-family:Arial,sans-serif;direction:rtl">
          <h2>دوکان‌یار</h2>
          <p>کد تأیید ایمیل شما:</p>
          <h1 style="letter-spacing:8px">${code}</h1>
          <p>این کد برای مدت محدود معتبر است.</p>
        </div>
      `,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    return {
      success: false,
      error: text || "خطا در ارسال ایمیل",
    };
  }

  return {
    success: true,
  };
}

/* =========================
   DASHBOARD
========================= */

async function dashboard(req, res, user) {
  /*
    نکته مهم:
    آمار از transactions گرفته می‌شود،
    نه از تعداد محصولات.
  */

  const shopId = user.shop_id;

  const stats = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE type = 'buy') AS buy_transactions,
      COUNT(*) FILTER (WHERE type = 'sell') AS sell_transactions,

      COALESCE(
        SUM(base_total) FILTER (WHERE type = 'buy'),
        0
      ) AS total_buy,

      COALESCE(
        SUM(base_total) FILTER (WHERE type = 'sell'),
        0
      ) AS total_sell,

      COALESCE(
        SUM(profit) FILTER (WHERE type = 'sell'),
        0
      ) AS total_profit,

      COALESCE(
        SUM(quantity) FILTER (WHERE type = 'buy'),
        0
      ) AS bought_quantity,

      COALESCE(
        SUM(quantity) FILTER (WHERE type = 'sell'),
        0
      ) AS sold_quantity

    FROM transactions
    WHERE shop_id = $1
    `,
    [shopId]
  );

  const products = await pool.query(
    `
    SELECT
      COUNT(*) AS product_count,
      COALESCE(SUM(quantity), 0) AS stock_quantity,
      COUNT(*) FILTER (
        WHERE quantity <= 3
      ) AS low_stock_count
    FROM products
    WHERE shop_id = $1
    `,
    [shopId]
  );

  const today = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE type = 'buy') AS today_buys,
      COUNT(*) FILTER (WHERE type = 'sell') AS today_sells,

      COALESCE(
        SUM(base_total) FILTER (WHERE type = 'buy'),
        0
      ) AS today_buy_total,

      COALESCE(
        SUM(base_total) FILTER (WHERE type = 'sell'),
        0
      ) AS today_sell_total,

      COALESCE(
        SUM(profit) FILTER (WHERE type = 'sell'),
        0
      ) AS today_profit

    FROM transactions
    WHERE
      shop_id = $1
      AND created_at >= CURRENT_DATE
    `,
    [shopId]
  );

  const s = stats.rows[0];
  const p = products.rows[0];
  const t = today.rows[0];

  const totalBuy = number(s.total_buy);
  const totalSell = number(s.total_sell);
  const totalProfit = number(s.total_profit);

  const todayBuyTotal = number(t.today_buy_total);
  const todaySellTotal = number(t.today_sell_total);
  const todayProfit = number(t.today_profit);

  return send(res, {
    success: true,

    dashboard: {
      buy_transactions: number(s.buy_transactions),
      sell_transactions: number(s.sell_transactions),

      total_buy: totalBuy,
      total_sell: totalSell,
      total_profit: totalProfit,

      bought_quantity: number(s.bought_quantity),
      sold_quantity: number(s.sold_quantity),

      product_count: number(p.product_count),
      stock_quantity: number(p.stock_quantity),
      low_stock_count: number(p.low_stock_count),

      today: {
        buys: number(t.today_buys),
        sells: number(t.today_sells),
        buy_total: todayBuyTotal,
        sell_total: todaySellTotal,
        profit: todayProfit,
      },
    },

    /* برای سازگاری با نسخه‌های مختلف frontend */
    buy: number(s.buy_transactions),
    sell: number(s.sell_transactions),
    purchases: number(s.buy_transactions),
    sales: number(s.sell_transactions),

    total_buy: totalBuy,
    total_sell: totalSell,
    profit: totalProfit,

    products: number(p.product_count),
    stock: number(p.stock_quantity),
    low_stock: number(p.low_stock_count),
  });
}

/* =========================
   PRODUCTS
========================= */

async function products(req, res, user) {
  const shopId = user.shop_id;

  if (req.method === "GET") {
    const result = await pool.query(
      `
      SELECT *
      FROM products
      WHERE shop_id = $1
      ORDER BY id DESC
      `,
      [shopId]
    );

    return send(res, {
      success: true,
      products: result.rows,
      count: result.rows.length,
    });
  }

  const body = await getBody(req);

  if (req.method === "POST") {
    const name = String(body.name || "").trim();

    if (!name) {
      return send(
        res,
        {
          success: false,
          error: "نام محصول الزامی است.",
        },
        400
      );
    }

    const result = await pool.query(
      `
      INSERT INTO products
      (
        shop_id,
        name,
        brand,
        model,
        buy_price,
        sell_price,
        quantity
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        shopId,
        name,
        body.brand || "",
        body.model || "",
        number(body.buy_price),
        number(body.sell_price),
        number(body.quantity),
      ]
    );

    return send(res, {
      success: true,
      product: result.rows[0],
    });
  }

  if (req.method === "PUT") {
    const id = number(body.id);

    const result = await pool.query(
      `
      UPDATE products
      SET
        name = COALESCE($1,name),
        brand = COALESCE($2,brand),
        model = COALESCE($3,model),
        buy_price = COALESCE($4,buy_price),
        sell_price = COALESCE($5,sell_price),
        quantity = COALESCE($6,quantity)
      WHERE id = $7
        AND shop_id = $8
      RETURNING *
      `,
      [
        body.name,
        body.brand,
        body.model,
        body.buy_price !== undefined
          ? number(body.buy_price)
          : null,
        body.sell_price !== undefined
          ? number(body.sell_price)
          : null,
        body.quantity !== undefined
          ? number(body.quantity)
          : null,
        id,
        shopId,
      ]
    );

    return send(res, {
      success: true,
      product: result.rows[0] || null,
    });
  }

  if (req.method === "DELETE") {
    const id = number(body.id || req.query.id);

    await pool.query(
      `
      DELETE FROM products
      WHERE id = $1
        AND shop_id = $2
      `,
      [id, shopId]
    );

    return send(res, {
      success: true,
    });
  }

  return send(res, { success: false, error: "Method not allowed" }, 405);
}

/* =========================
   BUY
========================= */

async function buy(req, res, user) {
  const body = await getBody(req);

  const productId = number(body.product_id);
  const qty = number(body.quantity);
  const buyPrice = number(
    body.unit_price ?? body.buy_price
  );

  const currency = String(body.currency || "AFN").toUpperCase();
  const rate = currencyRate(currency, body.currency_rate);

  if (!productId || qty <= 0 || buyPrice <= 0) {
    return send(
      res,
      {
        success: false,
        error: "محصول، تعداد و قیمت خرید را درست وارد کنید.",
      },
      400
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `
      SELECT *
      FROM products
      WHERE id = $1
        AND shop_id = $2
      FOR UPDATE
      `,
      [productId, user.shop_id]
    );

    if (!productResult.rows.length) {
      throw new Error("محصول پیدا نشد.");
    }

    const product = productResult.rows[0];

    const oldStock = number(product.quantity);
    const oldBuyPrice = number(product.buy_price);

    const baseBuyUnitPrice = buyPrice * rate;

    const newStock = oldStock + qty;

    const newAverageBuy =
      newStock > 0
        ? (
            oldStock * oldBuyPrice +
            qty * baseBuyUnitPrice
          ) / newStock
        : baseBuyUnitPrice;

    const rawTotal = qty * buyPrice;
    const baseTotal = rawTotal * rate;

    await client.query(
      `
      UPDATE products
      SET
        quantity = $1,
        buy_price = $2
      WHERE id = $3
        AND shop_id = $4
      `,
      [
        newStock,
        newAverageBuy,
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
      (
        $1,$2,$3,'buy',$4,$5,$6,0,0,
        $7,$8,$9,$10
      )
      RETURNING *
      `,
      [
        user.shop_id,
        productId,
        user.id,
        qty,
        buyPrice,
        rawTotal,
        currency,
        rate,
        baseBuyUnitPrice,
        baseTotal,
      ]
    );

    await client.query("COMMIT");

    return send(res, {
      success: true,
      message: "خرید با موفقیت ثبت شد.",
      transaction: transaction.rows[0],
      stock: newStock,
      average_buy_price: newAverageBuy,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    return send(
      res,
      {
        success: false,
        error: error.message,
      },
      400
    );
  } finally {
    client.release();
  }
}

/* =========================
   SELL
========================= */

async function sell(req, res, user) {
  const body = await getBody(req);

  const productId = number(body.product_id);
  const qty = number(body.quantity);

  const sellPrice = number(
    body.unit_price ?? body.sell_price
  );

  const currency = String(body.currency || "AFN").toUpperCase();
  const rate = currencyRate(currency, body.currency_rate);

  if (!productId || qty <= 0 || sellPrice <= 0) {
    return send(
      res,
      {
        success: false,
        error: "محصول، تعداد و قیمت فروش را درست وارد کنید.",
      },
      400
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `
      SELECT *
      FROM products
      WHERE id = $1
        AND shop_id = $2
      FOR UPDATE
      `,
      [productId, user.shop_id]
    );

    if (!productResult.rows.length) {
      throw new Error("محصول پیدا نشد.");
    }

    const product = productResult.rows[0];

    const stock = number(product.quantity);
    const averageBuy = number(product.buy_price);

    if (qty > stock) {
      throw new Error(
        `موجودی کافی نیست. موجودی فعلی: ${stock}`
      );
    }

    const baseSellUnitPrice = sellPrice * rate;

    const rawTotal = qty * sellPrice;
    const baseTotal = rawTotal * rate;

    const buyCost = qty * averageBuy;

    const profit = baseTotal - buyCost;

    const newStock = stock - qty;

    await client.query(
      `
      UPDATE products
      SET quantity = $1
      WHERE id = $2
        AND shop_id = $3
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
      (
        $1,$2,$3,'sell',$4,$5,$6,$7,$8,
        $9,$10,$11,$12
      )
      RETURNING *
      `,
      [
        user.shop_id,
        productId,
        user.id,
        qty,
        sellPrice,
        rawTotal,
        buyCost,
        profit,
        currency,
        rate,
        baseSellUnitPrice,
        baseTotal,
      ]
    );

    await client.query("COMMIT");

    return send(res, {
      success: true,
      message: "فروش با موفقیت ثبت شد.",
      transaction: transaction.rows[0],
      stock: newStock,
      buy_cost: buyCost,
      profit,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    return send(
      res,
      {
        success: false,
        error: error.message,
      },
      400
    );
  } finally {
    client.release();
  }
}

/* =========================
   TRANSACTIONS
========================= */

async function transactions(req, res, user) {
  const result = await pool.query(
    `
    SELECT
      t.*,
      p.name AS product_name
    FROM transactions t
    LEFT JOIN products p ON p.id = t.product_id
    WHERE t.shop_id = $1
    ORDER BY t.id DESC
    LIMIT 500
    `,
    [user.shop_id]
  );

  return send(res, {
    success: true,
    transactions: result.rows,
    count: result.rows.length,
  });
}

/* =========================
   PORTFOLIO
========================= */

async function portfolio(req, res, user) {
  const result = await pool.query(
    `
    SELECT *
    FROM products
    WHERE shop_id = $1
    ORDER BY id DESC
    `,
    [user.shop_id]
  );

  let stockValue = 0;

  for (const p of result.rows) {
    stockValue +=
      number(p.quantity) * number(p.buy_price);
  }

  return send(res, {
    success: true,
    products: result.rows,
    stock_value: stockValue,
  });
}

/* =========================
   WORKERS
========================= */

async function workers(req, res, user) {
  if (user.role !== "owner") {
    return send(
      res,
      {
        success: false,
        error: "فقط صاحب دوکان اجازه این کار را دارد.",
      },
      403
    );
  }

  if (req.method === "GET") {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        username,
        email,
        role,
        email_verified,
        created_at
      FROM users
      WHERE shop_id = $1
        AND role = 'worker'
      ORDER BY id DESC
      `,
      [user.shop_id]
    );

    return send(res, {
      success: true,
      workers: result.rows,
    });
  }

  const body = await getBody(req);

  if (req.method === "POST") {
    const password = String(body.password || "");

    if (password.length < 4) {
      return send(
        res,
        {
          success: false,
          error: "رمز کارمند حداقل ۴ حرف باشد.",
        },
        400
      );
    }

    const hash = hashPassword(password);

    const result = await pool.query(
      `
      INSERT INTO users
      (
        shop_id,
        name,
        username,
        email,
        password,
        password_hash,
        role,
        email_verified
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,'worker',TRUE)
      RETURNING
        id,name,username,email,role
      `,
      [
        user.shop_id,
        body.name || "",
        body.username || "",
        normalizeEmail(body.email),
        hash,
        hash,
      ]
    );

    return send(res, {
      success: true,
      worker: result.rows[0],
    });
  }

  if (req.method === "DELETE") {
    const id = number(body.id || req.query.id);

    await pool.query(
      `
      DELETE FROM users
      WHERE
        id = $1
        AND shop_id = $2
        AND role = 'worker'
      `,
      [id, user.shop_id]
    );

    return send(res, {
      success: true,
    });
  }

  return send(res, {
    success: false,
    error: "Method not allowed",
  }, 405);
}

/* =========================
   SHOP
========================= */

async function shop(req, res, user) {
  if (req.method === "GET") {
    const result = await pool.query(
      `
      SELECT *
      FROM shops
      WHERE id = $1
      `,
      [user.shop_id]
    );

    return send(res, {
      success: true,
      shop: result.rows[0] || null,
    });
  }

  if (req.method === "PUT") {
    if (user.role !== "owner") {
      return send(
        res,
        {
          success: false,
          error: "فقط صاحب دوکان اجازه تغییر دارد.",
        },
        403
      );
    }

    const body = await getBody(req);

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
        body.name,
        body.phone,
        body.address,
        user.shop_id,
      ]
    );

    return send(res, {
      success: true,
      shop: result.rows[0],
    });
  }

  return send(res, {
    success: false,
    error: "Method not allowed",
  }, 405);
}

/* =========================
   REGISTER
========================= */

async function register(req, res) {
  const body = await getBody(req);

  const shopName = String(body.shop_name || "").trim();
  const name = String(body.name || "").trim();
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!shopName || !name || !email || password.length < 4) {
    return send(
      res,
      {
        success: false,
        error: "اطلاعات ثبت‌نام کامل نیست.",
      },
      400
    );
  }

  const exists = await pool.query(
    `
    SELECT id
    FROM users
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [email]
  );

  if (exists.rows.length) {
    return send(
      res,
      {
        success: false,
        error: "این ایمیل قبلاً ثبت شده است.",
      },
      400
    );
  }

  const shopResult = await pool.query(
    `
    INSERT INTO shops(name)
    VALUES($1)
    RETURNING id
    `,
    [shopName]
  );

  const shopId = shopResult.rows[0].id;

  const hash = hashPassword(password);

  const code = String(
    Math.floor(100000 + Math.random() * 900000)
  );

  const expires = new Date(Date.now() + 10 * 60 * 1000);

  const userResult = await pool.query(
    `
    INSERT INTO users
    (
      shop_id,
      name,
      email,
      password,
      password_hash,
      role,
      email_verified,
      verification_code,
      verification_expires
    )
    VALUES
    (
      $1,$2,$3,$4,$5,'owner',FALSE,$6,$7
    )
    RETURNING id,email
    `,
    [
      shopId,
      name,
      email,
      hash,
      hash,
      code,
      expires,
    ]
  );

  const emailResult = await sendVerificationEmail(
    email,
    code
  );

  if (!emailResult.success) {
    return send(res, {
      success: true,
      user: userResult.rows[0],
      email_verification: false,
      warning: emailResult.error,
    });
  }

  return send(res, {
    success: true,
    user: userResult.rows[0],
    email_verification: true,
    message: "کد تأیید به ایمیل ارسال شد.",
  });
}

/* =========================
   VERIFY EMAIL
========================= */

async function verifyEmail(req, res) {
  const body = await getBody(req);

  const email = normalizeEmail(body.email);
  const code = String(body.code || "").trim();

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
    return send(
      res,
      {
        success: false,
        error: "کاربر پیدا نشد.",
      },
      404
    );
  }

  const user = result.rows[0];

  if (user.email_verified) {
    return send(res, {
      success: true,
      message: "ایمیل قبلاً تأیید شده است.",
    });
  }

  if (
    !user.verification_expires ||
    new Date(user.verification_expires) < new Date()
  ) {
    return send(
      res,
      {
        success: false,
        error: "کد منقضی شده است.",
      },
      400
    );
  }

  if (String(user.verification_code) !== code) {
    return send(
      res,
      {
        success: false,
        error: "کد تأیید اشتباه است.",
      },
      400
    );
  }

  await pool.query(
    `
    UPDATE users
    SET
      email_verified = TRUE,
      verification_code = '',
      verification_expires = NULL
    WHERE id = $1
    `,
    [user.id]
  );

  return send(res, {
    success: true,
    message: "ایمیل با موفقیت تأیید شد.",
  });
}

/* =========================
   LOGIN
========================= */

async function login(req, res) {
  const body = await getBody(req);

  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

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
    return send(
      res,
      {
        success: false,
        error: "ایمیل یا رمز عبور اشتباه است.",
      },
      401
    );
  }

  const user = result.rows[0];

  if (!user.email_verified) {
    return send(
      res,
      {
        success: false,
        error: "ابتدا ایمیل خود را تأیید کنید.",
        email_verified: false,
      },
      403
    );
  }

  const hash = hashPassword(password);

  if (
    hash !== user.password_hash &&
    hash !== user.password
  ) {
    return send(
      res,
      {
        success: false,
        error: "ایمیل یا رمز عبور اشتباه است.",
      },
      401
    );
  }

  const userToken = token();

  await pool.query(
    `
    UPDATE users
    SET token = $1
    WHERE id = $2
    `,
    [userToken, user.id]
  );

  return send(res, {
    success: true,
    token: userToken,
    user: {
      id: user.id,
      shop_id: user.shop_id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
}

/* =========================
   MAIN
========================= */

module.exports = async function handler(req, res) {
  headers(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    await setupDatabase();

    const path =
      req.query?.path ||
      req.url?.split("?")[0] ||
      "";

    const cleanPath = Array.isArray(path)
      ? "/" + path.join("/")
      : String(path);

    /* root */

    if (
      cleanPath === "/" ||
      cleanPath === "/api" ||
      cleanPath === "/api/"
    ) {
      return send(res, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: true,
        email_verification: true,
        resend_configured: !!process.env.RESEND_API_KEY,
      });
    }

    /* setup */

    if (cleanPath.endsWith("/setup")) {
      return send(res, {
        success: true,
        app: "Dokanyaar",
        message: "دیتابیس و جداول دوکان‌یار آماده است.",
        database: true,
        email_verification: true,
        resend_configured: !!process.env.RESEND_API_KEY,
      });
    }

    /* register */

    if (cleanPath.endsWith("/register")) {
      if (req.method !== "POST") {
        return send(res, {
          success: false,
          error: "Method not allowed",
        }, 405);
      }

      return register(req, res);
    }

    /* verify */

    if (
      cleanPath.endsWith("/verify-email") ||
      cleanPath.endsWith("/verify")
    ) {
      if (req.method !== "POST") {
        return send(res, {
          success: false,
          error: "Method not allowed",
        }, 405);
      }

      return verifyEmail(req, res);
    }

    /* resend */

    if (
      cleanPath.endsWith("/resend-code") ||
      cleanPath.endsWith("/resend-verification")
    ) {
      if (req.method !== "POST") {
        return send(res, {
          success: false,
          error: "Method not allowed",
        }, 405);
      }

      const body = await getBody(req);
      const email = normalizeEmail(body.email);

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
        return send(res, {
          success: false,
          error: "ایمیل پیدا نشد.",
        }, 404);
      }

      const user = result.rows[0];

      const code = String(
        Math.floor(100000 + Math.random() * 900000)
      );

      const expires = new Date(
        Date.now() + 10 * 60 * 1000
      );

      await pool.query(
        `
        UPDATE users
        SET
          verification_code = $1,
          verification_expires = $2,
          last_verification_sent = NOW()
        WHERE id = $3
        `,
        [code, expires, user.id]
      );

      const emailResult =
        await sendVerificationEmail(email, code);

      if (!emailResult.success) {
        return send(res, {
          success: false,
          error: emailResult.error,
        }, 500);
      }

      return send(res, {
        success: true,
        message: "کد جدید ارسال شد.",
      });
    }

    /* login */

    if (cleanPath.endsWith("/login")) {
      if (req.method !== "POST") {
        return send(res, {
          success: false,
          error: "Method not allowed",
        }, 405);
      }

      return login(req, res);
    }

    /* protected routes */

    const user = await getUser(req);

    if (!user) {
      return send(
        res,
        {
          success: false,
          error: "لطفاً وارد حساب شوید.",
        },
        401
      );
    }

    if (cleanPath.endsWith("/logout")) {
      await pool.query(
        `
        UPDATE users
        SET token = ''
        WHERE id = $1
        `,
        [user.id]
      );

      return send(res, {
        success: true,
      });
    }

    if (cleanPath.endsWith("/me")) {
      return send(res, {
        success: true,
        user: {
          id: user.id,
          shop_id: user.shop_id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    }

    if (cleanPath.endsWith("/dashboard")) {
      return dashboard(req, res, user);
    }

    if (cleanPath.endsWith("/products")) {
      return products(req, res, user);
    }

    if (cleanPath.endsWith("/buy")) {
      if (req.method !== "POST") {
        return send(res, {
          success: false,
          error: "Method not allowed",
        }, 405);
      }

      return buy(req, res, user);
    }

    if (cleanPath.endsWith("/sell")) {
      if (req.method !== "POST") {
        return send(res, {
          success: false,
          error: "Method not allowed",
        }, 405);
      }

      return sell(req, res, user);
    }

    if (
      cleanPath.endsWith("/transactions") ||
      cleanPath.endsWith("/history")
    ) {
      return transactions(req, res, user);
    }

    if (cleanPath.endsWith("/portfolio")) {
      return portfolio(req, res, user);
    }

    if (cleanPath.endsWith("/workers")) {
      return workers(req, res, user);
    }

    if (cleanPath.endsWith("/shop")) {
      return shop(req, res, user);
    }

    if (cleanPath.endsWith("/user")) {
      return send(res, {
        success: true,
        user: {
          id: user.id,
          shop_id: user.shop_id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    }

    return send(
      res,
      {
        success: false,
        error: "Endpoint not found",
        path: cleanPath,
      },
      404
    );
  } catch (error) {
    console.error(error);

    return send(
      res,
      {
        success: false,
        error: error.message || "خطای سرور",
      },
      500
    );
  }
};