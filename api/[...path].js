const { Pool } = require("pg");
const crypto = require("crypto");

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    throw new Error("DATABASE_URL پیدا نشد.");
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5
  });

  return pool;
}

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-auth-token"
  );
}

function send(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(data);
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getToken(req) {
  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    return auth.substring(7).trim();
  }

  return req.headers["x-auth-token"] || "";
}

async function getBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  return new Promise((resolve) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

/* =====================================================
   DATABASE
===================================================== */

async function setupDatabase() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'دوکان من',
      owner_name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER,
      username TEXT,
      password_hash TEXT,
      full_name TEXT DEFAULT '',
      role TEXT DEFAULT 'worker',
      token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_id INTEGER
  `);

  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT
  `);

  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT
  `);

  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT ''
  `);

  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'worker'
  `);

  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token TEXT
  `);

  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER,
      name TEXT NOT NULL,
      brand TEXT DEFAULT '',
      model TEXT DEFAULT '',
      buy_price NUMERIC(18,2) DEFAULT 0,
      sell_price NUMERIC(18,2) DEFAULT 0,
      quantity INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_id INTEGER
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT ''
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS model TEXT DEFAULT ''
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS buy_price NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sell_price NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await db.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  /* TRANSACTIONS */

  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER,
      product_id INTEGER,
      user_id INTEGER,
      type TEXT,
      quantity INTEGER DEFAULT 0,

      unit_price NUMERIC(18,2) DEFAULT 0,
      total NUMERIC(18,2) DEFAULT 0,

      buy_cost NUMERIC(18,2) DEFAULT 0,
      profit NUMERIC(18,2) DEFAULT 0,

      currency TEXT DEFAULT 'AFN',
      currency_rate NUMERIC(18,4) DEFAULT 1,

      base_unit_price NUMERIC(18,2) DEFAULT 0,
      base_total NUMERIC(18,2) DEFAULT 0,
      base_buy_cost NUMERIC(18,2) DEFAULT 0,

      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS shop_id INTEGER
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS product_id INTEGER
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS user_id INTEGER
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS type TEXT
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS total NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS buy_cost NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS profit NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'AFN'
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS currency_rate NUMERIC(18,4) DEFAULT 1
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS base_total NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS base_buy_cost NUMERIC(18,2) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  /* اطلاعات قدیمی را AFN در نظر می‌گیریم */
  await db.query(`
    UPDATE transactions
    SET currency = 'AFN'
    WHERE currency IS NULL OR currency = ''
  `);

  await db.query(`
    UPDATE transactions
    SET currency_rate = 1
    WHERE currency_rate IS NULL OR currency_rate <= 0
  `);

  await db.query(`
    UPDATE transactions
    SET base_unit_price = unit_price
    WHERE base_unit_price IS NULL OR base_unit_price = 0
  `);

  await db.query(`
    UPDATE transactions
    SET base_total = total
    WHERE base_total IS NULL OR base_total = 0
  `);

  await db.query(`
    UPDATE transactions
    SET base_buy_cost = buy_cost
    WHERE base_buy_cost IS NULL OR base_buy_cost = 0
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_users_token
    ON users(token)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_products_shop
    ON products(shop_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_shop
    ON transactions(shop_id)
  `);

  return true;
}

/* =====================================================
   AUTH
===================================================== */

async function auth(req) {
  const token = getToken(req);

  if (!token) return null;

  const db = getPool();

  const result = await db.query(`
    SELECT
      u.id,
      u.shop_id,
      u.username,
      u.full_name,
      u.role,
      s.name AS shop_name,
      s.owner_name
    FROM users u
    LEFT JOIN shops s ON s.id = u.shop_id
    WHERE u.token = $1
    LIMIT 1
  `, [token]);

  return result.rows[0] || null;
}

function needLogin(user, res) {
  if (!user) {
    send(res, 401, {
      success: false,
      error: "لطفاً وارد حساب شوید."
    });

    return false;
  }

  return true;
}

/* =====================================================
   CURRENCY
===================================================== */

function getTransactionCurrency(data) {
  const c = String(data.currency || "AFN").toUpperCase();

  if (c !== "AFN" && c !== "USD") {
    throw new Error("ارز باید AFN یا USD باشد.");
  }

  return c;
}

function getTransactionRate(data, currency) {
  if (currency === "AFN") return 1;

  const rate = Number(data.currency_rate);

  if (!rate || rate <= 0) {
    throw new Error(
      "برای معامله دالری نرخ تبدیل را وارد کنید. مثال: 1 USD = 70 AFN"
    );
  }

  return rate;
}

/* =====================================================
   HANDLER
===================================================== */

module.exports = async (req, res) => {
  cors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    await setupDatabase();

    const parsed = new URL(
      req.url,
      `https://${req.headers.host || "dokanyar-six.vercel.app"}`
    );

    let path = parsed.pathname;

    if (path.startsWith("/api")) {
      path = path.substring(4);
    }

    if (!path) path = "/";

    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    const method = req.method.toUpperCase();

    /* ROOT */

    if (method === "GET" && path === "/") {
      return send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: true,
        currency_receipts: true
      });
    }

    /* SETUP */

    if (
      (method === "GET" || method === "POST") &&
      path === "/setup"
    ) {
      return send(res, 200, {
        success: true,
        message: "Database migration completed.",
        database: true,
        currency_receipts: true
      });
    }

    /* REGISTER */

    if (method === "POST" && path === "/register") {
      const data = await getBody(req);

      const shopName = String(data.shop_name || "").trim();
      const ownerName = String(data.owner_name || "").trim();
      const username = String(data.username || "").trim();
      const password = String(data.password || "");

      if (!shopName || !username || password.length < 4) {
        return send(res, 400, {
          success: false,
          error: "نام دوکان، نام کاربری و رمز حداقل ۴ حرف لازم است."
        });
      }

      const db = getPool();

      const exists = await db.query(`
        SELECT id
        FROM users
        WHERE username = $1
        LIMIT 1
      `, [username]);

      if (exists.rows.length) {
        return send(res, 409, {
          success: false,
          error: "این نام کاربری قبلاً استفاده شده است."
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const shop = await client.query(`
          INSERT INTO shops(name, owner_name)
          VALUES($1,$2)
          RETURNING id
        `, [shopName, ownerName]);

        const shopId = shop.rows[0].id;
        const token = makeToken();

        const user = await client.query(`
          INSERT INTO users(
            shop_id,
            username,
            password_hash,
            full_name,
            role,
            token
          )
          VALUES($1,$2,$3,$4,'owner',$5)
          RETURNING id, shop_id, username, full_name, role
        `, [
          shopId,
          username,
          hashPassword(password),
          ownerName,
          token
        ]);

        await client.query("COMMIT");

        return send(res, 201, {
          success: true,
          message: "دوکان با موفقیت ثبت شد.",
          token,
          user: user.rows[0]
        });

      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    /* LOGIN */

    if (method === "POST" && path === "/login") {
      const data = await getBody(req);

      const username = String(data.username || "").trim();
      const password = String(data.password || "");

      const db = getPool();

      const result = await db.query(`
        SELECT
          u.id,
          u.shop_id,
          u.username,
          u.full_name,
          u.role,
          s.name AS shop_name,
          s.owner_name
        FROM users u
        LEFT JOIN shops s ON s.id = u.shop_id
        WHERE u.username = $1
          AND u.password_hash = $2
        LIMIT 1
      `, [
        username,
        hashPassword(password)
      ]);

      if (!result.rows.length) {
        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
      }

      const user = result.rows[0];
      const token = makeToken();

      await db.query(`
        UPDATE users
        SET token = $1
        WHERE id = $2
      `, [token, user.id]);

      return send(res, 200, {
        success: true,
        token,
        user
      });
    }

    /* LOGOUT */

    if (method === "POST" && path === "/logout") {
      const user = await auth(req);

      if (user) {
        const db = getPool();

        await db.query(`
          UPDATE users
          SET token = NULL
          WHERE id = $1
        `, [user.id]);
      }

      return send(res, 200, {
        success: true
      });
    }

    /* ME */

    if (method === "GET" && path === "/me") {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      return send(res, 200, {
        success: true,
        user
      });
    }

    /* PRODUCTS */

    if (path === "/products") {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const db = getPool();

      if (method === "GET") {
        const result = await db.query(`
          SELECT
            id,
            name,
            brand,
            model,
            buy_price,
            sell_price,
            quantity,
            created_at,
            updated_at
          FROM products
          WHERE shop_id = $1
          ORDER BY id DESC
        `, [user.shop_id]);

        return send(res, 200, {
          success: true,
          products: result.rows
        });
      }

      if (method === "POST") {
        const data = await getBody(req);

        const name = String(data.name || "").trim();

        if (!name) {
          return send(res, 400, {
            success: false,
            error: "نام محصول لازم است."
          });
        }

        const result = await db.query(`
          INSERT INTO products(
            shop_id,
            name,
            brand,
            model,
            buy_price,
            sell_price,
            quantity
          )
          VALUES($1,$2,$3,$4,$5,$6,$7)
          RETURNING *
        `, [
          user.shop_id,
          name,
          String(data.brand || ""),
          String(data.model || ""),
          Number(data.buy_price || 0),
          Number(data.sell_price || 0),
          Math.max(0, Number(data.quantity || 0))
        ]);

        return send(res, 201, {
          success: true,
          product: result.rows[0]
        });
      }
    }

    /* PRODUCT ID */

    const productMatch = path.match(/^\/products\/(\d+)$/);

    if (productMatch) {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const id = Number(productMatch[1]);
      const db = getPool();

      if (method === "PUT") {
        const data = await getBody(req);

        const result = await db.query(`
          UPDATE products
          SET
            name = $1,
            brand = $2,
            model = $3,
            buy_price = $4,
            sell_price = $5,
            quantity = $6,
            updated_at = NOW()
          WHERE id = $7
            AND shop_id = $8
          RETURNING *
        `, [
          String(data.name || ""),
          String(data.brand || ""),
          String(data.model || ""),
          Number(data.buy_price || 0),
          Number(data.sell_price || 0),
          Math.max(0, Number(data.quantity || 0)),
          id,
          user.shop_id
        ]);

        if (!result.rows.length) {
          return send(res, 404, {
            success: false,
            error: "محصول پیدا نشد."
          });
        }

        return send(res, 200, {
          success: true,
          product: result.rows[0]
        });
      }

      if (method === "DELETE") {
        await db.query(`
          DELETE FROM products
          WHERE id = $1
            AND shop_id = $2
        `, [id, user.shop_id]);

        return send(res, 200, {
          success: true,
          message: "محصول حذف شد."
        });
      }
    }

    /* =====================================================
       BUY
    ===================================================== */

    if (method === "POST" && path === "/buy") {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const data = await getBody(req);

      const productId = Number(data.product_id);
      const quantity = Number(data.quantity);
      const unitPrice = Number(data.unit_price);

      if (
        !productId ||
        quantity <= 0 ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "اطلاعات خرید نادرست است."
        });
      }

      let currency;
      let rate;

      try {
        currency = getTransactionCurrency(data);
        rate = getTransactionRate(data, currency);
      } catch (e) {
        return send(res, 400, {
          success: false,
          error: e.message
        });
      }

      /*
        قیمت داخلی همیشه AFN است.
        اگر خرید USD باشد:
        USD × نرخ = AFN
      */

      const baseUnitPrice =
        currency === "USD"
          ? unitPrice * rate
          : unitPrice;

      const total =
        quantity * unitPrice;

      const baseTotal =
        quantity * baseUnitPrice;

      const db = getPool();
      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(`
          SELECT *
          FROM products
          WHERE id = $1
            AND shop_id = $2
          FOR UPDATE
        `, [productId, user.shop_id]);

        if (!result.rows.length) {
          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "محصول پیدا نشد."
          });
        }

        const p = result.rows[0];

        const oldQty = Number(p.quantity || 0);
        const oldBuy = Number(p.buy_price || 0);

        const newQty = oldQty + quantity;

        /*
          میانگین خرید همیشه به AFN محاسبه می‌شود.
        */

        const average =
          newQty > 0
            ? (
                oldQty * oldBuy +
                quantity * baseUnitPrice
              ) / newQty
            : baseUnitPrice;

        await client.query(`
          UPDATE products
          SET
            quantity = $1,
            buy_price = $2,
            updated_at = NOW()
          WHERE id = $3
        `, [
          newQty,
          average,
          productId
        ]);

        await client.query(`
          INSERT INTO transactions(
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
            base_total,
            base_buy_cost
          )
          VALUES(
            $1,$2,$3,'buy',$4,$5,$6,$7,0,
            $8,$9,$10,$11,$11
          )
        `, [
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
          baseTotal
        ]);

        await client.query("COMMIT");

        return send(res, 200, {
          success: true,
          message: "خرید ثبت شد.",
          quantity: newQty,
          average_buy_price: average,
          currency,
          currency_rate: rate,
          receipt: {
            type: "خرید",
            quantity,
            unit_price: unitPrice,
            total,
            currency,
            currency_rate: rate,
            base_total: baseTotal
          }
        });

      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    /* =====================================================
       SELL
    ===================================================== */

    if (method === "POST" && path === "/sell") {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const data = await getBody(req);

      const productId = Number(data.product_id);
      const quantity = Number(data.quantity);
      const unitPrice = Number(data.unit_price);

      if (
        !productId ||
        quantity <= 0 ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "اطلاعات فروش نادرست است."
        });
      }

      let currency;
      let rate;

      try {
        currency = getTransactionCurrency(data);
        rate = getTransactionRate(data, currency);
      } catch (e) {
        return send(res, 400, {
          success: false,
          error: e.message
        });
      }

      const baseUnitPrice =
        currency === "USD"
          ? unitPrice * rate
          : unitPrice;

      const total =
        quantity * unitPrice;

      const baseTotal =
        quantity * baseUnitPrice;

      const db = getPool();
      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(`
          SELECT *
          FROM products
          WHERE id = $1
            AND shop_id = $2
          FOR UPDATE
        `, [productId, user.shop_id]);

        if (!result.rows.length) {
          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "محصول پیدا نشد."
          });
        }

        const p = result.rows[0];

        const stock = Number(p.quantity || 0);
        const buyPrice = Number(p.buy_price || 0);

        if (quantity > stock) {
          await client.query("ROLLBACK");

          return send(res, 400, {
            success: false,
            error: `موجودی کافی نیست. موجودی: ${stock}`
          });
        }

        /*
          قیمت خرید محصول AFN است.
          قیمت فروش هم برای سود به AFN تبدیل می‌شود.
        */

        const buyCost =
          quantity * buyPrice;

        const profit =
          baseTotal - buyCost;

        const newStock =
          stock - quantity;

        await client.query(`
          UPDATE products
          SET
            quantity = $1,
            updated_at = NOW()
          WHERE id = $2
        `, [
          newStock,
          productId
        ]);

        await client.query(`
          INSERT INTO transactions(
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
            base_total,
            base_buy_cost
          )
          VALUES(
            $1,$2,$3,'sell',$4,$5,$6,$7,$8,
            $9,$10,$11,$12,$13
          )
        `, [
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
          buyCost
        ]);

        await client.query("COMMIT");

        return send(res, 200, {
          success: true,
          message: "فروش ثبت شد.",
          quantity: newStock,
          profit,
          profit_currency: "AFN",
          currency,
          currency_rate: rate,
          receipt: {
            type: "فروش",
            quantity,
            unit_price: unitPrice,
            total,
            currency,
            currency_rate: rate,
            profit_afn: profit,
            base_total: baseTotal,
            buy_cost_afn: buyCost
          }
        });

      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    /* =====================================================
       TRANSACTIONS
    ===================================================== */

    if (method === "GET" && path === "/transactions") {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const db = getPool();

      const result = await db.query(`
        SELECT
          t.*,
          p.name AS product_name,
          u.username
        FROM transactions t
        LEFT JOIN products p
          ON p.id = t.product_id
        LEFT JOIN users u
          ON u.id = t.user_id
        WHERE t.shop_id = $1
        ORDER BY t.id DESC
        LIMIT 500
      `, [user.shop_id]);

      return send(res, 200, {
        success: true,
        transactions: result.rows
      });
    }

    /* =====================================================
       ONE TRANSACTION / RECEIPT
    ===================================================== */

    const transactionMatch =
      path.match(/^\/transactions\/(\d+)$/);

    if (
      transactionMatch &&
      method === "GET"
    ) {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const db = getPool();

      const result = await db.query(`
        SELECT
          t.*,
          p.name AS product_name,
          p.brand,
          p.model,
          u.username,
          s.name AS shop_name
        FROM transactions t
        LEFT JOIN products p
          ON p.id = t.product_id
        LEFT JOIN users u
          ON u.id = t.user_id
        LEFT JOIN shops s
          ON s.id = t.shop_id
        WHERE t.id = $1
          AND t.shop_id = $2
        LIMIT 1
      `, [
        Number(transactionMatch[1]),
        user.shop_id
      ]);

      if (!result.rows.length) {
        return send(res, 404, {
          success: false,
          error: "رسید پیدا نشد."
        });
      }

      return send(res, 200, {
        success: true,
        transaction: result.rows[0]
      });
    }

    /* =====================================================
       WORKERS
    ===================================================== */

    if (path === "/workers") {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const db = getPool();

      if (method === "GET") {
        const result = await db.query(`
          SELECT
            id,
            username,
            full_name,
            role,
            created_at
          FROM users
          WHERE shop_id = $1
          ORDER BY id DESC
        `, [user.shop_id]);

        return send(res, 200, {
          success: true,
          workers: result.rows
        });
      }

      if (method === "POST") {
        if (user.role !== "owner") {
          return send(res, 403, {
            success: false,
            error: "فقط صاحب دوکان اجازه دارد."
          });
        }

        const data = await getBody(req);

        const username =
          String(data.username || "").trim();

        const password =
          String(data.password || "");

        const fullName =
          String(data.full_name || "").trim();

        if (!username || password.length < 4) {
          return send(res, 400, {
            success: false,
            error: "نام کاربری و رمز حداقل ۴ حرف لازم است."
          });
        }

        const exists = await db.query(`
          SELECT id
          FROM users
          WHERE shop_id = $1
            AND username = $2
        `, [
          user.shop_id,
          username
        ]);

        if (exists.rows.length) {
          return send(res, 409, {
            success: false,
            error: "این کاربر قبلاً وجود دارد."
          });
        }

        const result = await db.query(`
          INSERT INTO users(
            shop_id,
            username,
            password_hash,
            full_name,
            role
          )
          VALUES($1,$2,$3,$4,'worker')
          RETURNING id, username, full_name, role
        `, [
          user.shop_id,
          username,
          hashPassword(password),
          fullName
        ]);

        return send(res, 201, {
          success: true,
          worker: result.rows[0]
        });
      }
    }

    /* DELETE WORKER */

    const workerMatch =
      path.match(/^\/workers\/(\d+)$/);

    if (
      workerMatch &&
      method === "DELETE"
    ) {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      if (user.role !== "owner") {
        return send(res, 403, {
          success: false,
          error: "فقط صاحب دوکان اجازه دارد."
        });
      }

      const db = getPool();

      await db.query(`
        DELETE FROM users
        WHERE id = $1
          AND shop_id = $2
          AND role = 'worker'
      `, [
        Number(workerMatch[1]),
        user.shop_id
      ]);

      return send(res, 200, {
        success: true,
        message: "کارمند حذف شد."
      });
    }

    /* =====================================================
       SHOP
    ===================================================== */

    if (path === "/shop") {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const db = getPool();

      if (method === "GET") {
        const result = await db.query(`
          SELECT *
          FROM shops
          WHERE id = $1
          LIMIT 1
        `, [user.shop_id]);

        return send(res, 200, {
          success: true,
          shop: result.rows[0] || null
        });
      }

      if (method === "PUT") {
        const data = await getBody(req);

        const name =
          String(
            data.name ||
            data.shop_name ||
            ""
          ).trim();

        if (!name) {
          return send(res, 400, {
            success: false,
            error: "نام دوکان لازم است."
          });
        }

        const result = await db.query(`
          UPDATE shops
          SET name = $1
          WHERE id = $2
          RETURNING *
        `, [
          name,
          user.shop_id
        ]);

        return send(res, 200, {
          success: true,
          shop: result.rows[0]
        });
      }
    }

    /* =====================================================
       DASHBOARD
    ===================================================== */

    if (
      method === "GET" &&
      path === "/dashboard"
    ) {
      const user = await auth(req);

      if (!needLogin(user, res)) return;

      const db = getPool();

      const productsResult = await db.query(`
        SELECT
          COUNT(*)::int AS product_count,
          COALESCE(SUM(quantity),0)::int AS total_quantity,
          COALESCE(
            SUM(quantity * buy_price),
            0
          )::numeric AS inventory_cost,
          COALESCE(
            SUM(quantity * sell_price),
            0
          )::numeric AS inventory_value
        FROM products
        WHERE shop_id = $1
      `, [user.shop_id]);

      /*
        گزارش‌های مالی اصلی به AFN هستند.
        چون معاملات USD و AFN قابل ترکیب مستقیم نیستند.
      */

      const sales = await db.query(`
        SELECT
          COALESCE(SUM(base_total),0)::numeric AS sales_total_afn,
          COALESCE(SUM(profit),0)::numeric AS profit_total_afn,
          COUNT(*)::int AS sales_count
        FROM transactions
        WHERE shop_id = $1
          AND type = 'sell'
      `, [user.shop_id]);

      const purchases = await db.query(`
        SELECT
          COALESCE(SUM(base_total),0)::numeric AS purchases_total_afn,
          COUNT(*)::int AS purchases_count
        FROM transactions
        WHERE shop_id = $1
          AND type = 'buy'
      `, [user.shop_id]);

      const low = await db.query(`
        SELECT COUNT(*)::int AS count
        FROM products
        WHERE shop_id = $1
          AND quantity <= 3
      `, [user.shop_id]);

      return send(res, 200, {
        success: true,
        dashboard: {
          products: productsResult.rows[0],
          sales: sales.rows[0],
          purchases: purchases.rows[0],
          low_stock: low.rows[0],
          accounting_currency: "AFN"
        }
      });
    }

    return send(res, 404, {
      success: false,
      error: "Endpoint not found",
      path
    });

  } catch (error) {
    console.error("DOKANYAAR ERROR:", error);

    return send(res, 500, {
      success: false,
      error: error.message || "خطای داخلی سرور"
    });
  }
};