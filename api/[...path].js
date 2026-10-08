const { Pool } = require("pg");
const crypto = require("crypto");

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("JSON نامعتبر است."));
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

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getToken(req) {
  const auth = req.headers.authorization || "";

  if (auth.indexOf("Bearer ") === 0) {
    return auth.substring(7);
  }

  return "";
}

function cleanPath(req) {
  let url = req.url || "/";
  let path = url.split("?")[0];

  if (path.indexOf("/api") === 0) {
    path = path.substring(4);
  }

  if (!path) {
    path = "/";
  }

  if (path.length > 1 && path.endsWith("/")) {
    path = path.substring(0, path.length - 1);
  }

  return path;
}

async function setupDatabase() {
  if (!pool) {
    throw new Error("DATABASE_URL تنظیم نشده است.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      owner_name TEXT NOT NULL DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      name TEXT DEFAULT '',
      role TEXT DEFAULT 'owner',
      token TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      brand TEXT DEFAULT '',
      model TEXT DEFAULT '',
      quantity NUMERIC(18,2) DEFAULT 0,
      buy_price NUMERIC(18,2) DEFAULT 0,
      sell_price NUMERIC(18,2) DEFAULT 0,
      min_stock NUMERIC(18,2) DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      user_id INTEGER,
      type TEXT NOT NULL,
      quantity NUMERIC(18,2) NOT NULL,
      unit_price NUMERIC(18,2) NOT NULL,
      total NUMERIC(18,2) NOT NULL,
      buy_cost NUMERIC(18,2) DEFAULT 0,
      profit NUMERIC(18,2) DEFAULT 0,
      currency TEXT DEFAULT 'AFN',
      currency_rate NUMERIC(18,6) DEFAULT 1,
      base_unit_price NUMERIC(18,2) DEFAULT 0,
      base_total NUMERIC(18,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migration برای دیتابیس قدیمی
  const alters = [
    `ALTER TABLE shops ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''`,
    `ALTER TABLE shops ADD COLUMN IF NOT EXISTS address TEXT DEFAULT ''`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_id INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'owner'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS token TEXT`,

    `ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_id INTEGER`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT ''`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS model TEXT DEFAULT ''`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS quantity NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS buy_price NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS sell_price NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock NUMERIC(18,2) DEFAULT 1`,

    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS shop_id INTEGER`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS product_id INTEGER`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id INTEGER`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type TEXT`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS quantity NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS total NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buy_cost NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS profit NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'AFN'`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency_rate NUMERIC(18,6) DEFAULT 1`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,2) DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS base_total NUMERIC(18,2) DEFAULT 0`
  ];

  for (let i = 0; i < alters.length; i++) {
    await pool.query(alters[i]);
  }

  // اطلاعات قدیمی را AFN در نظر می‌گیریم
  await pool.query(`
    UPDATE transactions
    SET currency = 'AFN'
    WHERE currency IS NULL OR currency = ''
  `);

  await pool.query(`
    UPDATE transactions
    SET currency_rate = 1
    WHERE currency_rate IS NULL OR currency_rate <= 0
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_type
    ON transactions(type)
  `);

  return true;
}

async function getUser(req) {
  if (!pool) {
    throw new Error("Database unavailable");
  }

  const token = getToken(req);

  if (!token) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT
      u.id,
      u.shop_id,
      u.username,
      u.name,
      u.role,
      s.id AS sid,
      s.name AS shop_name,
      s.owner_name,
      s.phone,
      s.address
    FROM users u
    LEFT JOIN shops s ON s.id = u.shop_id
    WHERE u.token = $1
    LIMIT 1
    `,
    [token]
  );

  if (!result.rows.length) {
    return null;
  }

  const r = result.rows[0];

  return {
    id: r.id,
    shop_id: r.shop_id,
    username: r.username,
    name: r.name,
    role: r.role,
    shop: {
      id: r.sid,
      name: r.shop_name,
      owner_name: r.owner_name,
      phone: r.phone,
      address: r.address
    }
  };
}

async function requireUser(req, res) {
  const user = await getUser(req);

  if (!user) {
    send(res, 401, {
      success: false,
      error: "لطفاً ابتدا وارد شوید."
    });

    return null;
  }

  return user;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 200, { success: true });
    return;
  }

  if (!pool) {
    send(res, 500, {
      success: false,
      error: "DATABASE_URL تنظیم نشده است."
    });
    return;
  }

  const path = cleanPath(req);
  const method = req.method;

  try {
    // ROOT
    if (path === "/" && method === "GET") {
      send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: true
      });
      return;
    }

    // SETUP
    if (path === "/setup" && (method === "GET" || method === "POST")) {
      await setupDatabase();

      send(res, 200, {
        success: true,
        message: "دیتابیس دوکان‌یار آماده است."
      });

      return;
    }

    await setupDatabase();

    // REGISTER
    if (path === "/register" && method === "POST") {
      const body = await getBody(req);

      const shopName = String(body.shop_name || "").trim();
      const ownerName = String(body.owner_name || "").trim();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (!shopName || !ownerName || !username || !password) {
        send(res, 400, {
          success: false,
          error: "تمام معلومات را وارد کنید."
        });
        return;
      }

      if (password.length < 4) {
        send(res, 400, {
          success: false,
          error: "رمز عبور حداقل 4 حرف باشد."
        });
        return;
      }

      const exists = await pool.query(
        `SELECT id FROM users WHERE username = $1 LIMIT 1`,
        [username]
      );

      if (exists.rows.length) {
        send(res, 400, {
          success: false,
          error: "این نام کاربری قبلاً استفاده شده است."
        });
        return;
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const shop = await client.query(
          `
          INSERT INTO shops(name, owner_name)
          VALUES($1,$2)
          RETURNING *
          `,
          [shopName, ownerName]
        );

        const shopId = shop.rows[0].id;
        const token = makeToken();

        const user = await client.query(
          `
          INSERT INTO users
          (shop_id, username, password, name, role, token)
          VALUES($1,$2,$3,$4,'owner',$5)
          RETURNING id, shop_id, username, name, role
          `,
          [
            shopId,
            username,
            hashPassword(password),
            ownerName,
            token
          ]
        );

        await client.query("COMMIT");

        send(res, 200, {
          success: true,
          token: token,
          user: user.rows[0],
          shop: shop.rows[0]
        });

      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      return;
    }

    // LOGIN
    if (path === "/login" && method === "POST") {
      const body = await getBody(req);

      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (!username || !password) {
        send(res, 400, {
          success: false,
          error: "نام کاربری و رمز عبور را وارد کنید."
        });
        return;
      }

      const result = await pool.query(
        `
        SELECT id, shop_id, username, name, role
        FROM users
        WHERE username = $1
        AND password = $2
        LIMIT 1
        `,
        [username, hashPassword(password)]
      );

      if (!result.rows.length) {
        send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
        return;
      }

      const user = result.rows[0];
      const token = makeToken();

      await pool.query(
        `UPDATE users SET token = $1 WHERE id = $2`,
        [token, user.id]
      );

      const shop = await pool.query(
        `SELECT * FROM shops WHERE id = $1 LIMIT 1`,
        [user.shop_id]
      );

      send(res, 200, {
        success: true,
        token: token,
        user: user,
        shop: shop.rows[0] || null
      });

      return;
    }

    // LOGOUT
    if (path === "/logout" && method === "POST") {
      const token = getToken(req);

      if (token) {
        await pool.query(
          `UPDATE users SET token = NULL WHERE token = $1`,
          [token]
        );
      }

      send(res, 200, {
        success: true
      });

      return;
    }

    // ME
    if (path === "/me" && method === "GET") {
      const user = await requireUser(req, res);

      if (!user) return;

      send(res, 200, {
        success: true,
        user: {
          id: user.id,
          shop_id: user.shop_id,
          username: user.username,
          name: user.name,
          role: user.role
        },
        shop: user.shop
      });

      return;
    }

    // SHOP GET
    if (path === "/shop" && method === "GET") {
      const user = await requireUser(req, res);

      if (!user) return;

      const result = await pool.query(
        `SELECT * FROM shops WHERE id = $1 LIMIT 1`,
        [user.shop_id]
      );

      send(res, 200, {
        success: true,
        shop: result.rows[0] || null
      });

      return;
    }

    // SHOP UPDATE
    if (path === "/shop" && method === "PUT") {
      const user = await requireUser(req, res);

      if (!user) return;

      const body = await getBody(req);

      const result = await pool.query(
        `
        UPDATE shops
        SET
          name = $1,
          owner_name = $2,
          phone = $3,
          address = $4
        WHERE id = $5
        RETURNING *
        `,
        [
          String(body.name || body.shop_name || ""),
          String(body.owner_name || ""),
          String(body.phone || ""),
          String(body.address || ""),
          user.shop_id
        ]
      );

      send(res, 200, {
        success: true,
        shop: result.rows[0]
      });

      return;
    }

    // PRODUCTS GET
    if (path === "/products" && method === "GET") {
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

      send(res, 200, {
        success: true,
        products: result.rows
      });

      return;
    }

    // PRODUCT CREATE
    if (path === "/products" && method === "POST") {
      const user = await requireUser(req, res);

      if (!user) return;

      const body = await getBody(req);

      const name = String(body.name || "").trim();

      if (!name) {
        send(res, 400, {
          success: false,
          error: "نام جنس را وارد کنید."
        });
        return;
      }

      const result = await pool.query(
        `
        INSERT INTO products
        (
          shop_id,
          name,
          brand,
          model,
          quantity,
          buy_price,
          sell_price,
          min_stock
        )
        VALUES($1,$2,$3,$4,0,0,0,$5)
        RETURNING *
        `,
        [
          user.shop_id,
          name,
          String(body.brand || ""),
          String(body.model || ""),
          Number(body.min_stock || 1)
        ]
      );

      send(res, 200, {
        success: true,
        product: result.rows[0]
      });

      return;
    }

    // PRODUCT UPDATE
    const productUpdateMatch = path.match(/^\/products\/(\d+)$/);

    if (productUpdateMatch && method === "PUT") {
      const user = await requireUser(req, res);

      if (!user) return;

      const id = Number(productUpdateMatch[1]);
      const body = await getBody(req);

      const result = await pool.query(
        `
        UPDATE products
        SET
          name = $1,
          brand = $2,
          model = $3,
          sell_price = $4,
          min_stock = $5
        WHERE id = $6
        AND shop_id = $7
        RETURNING *
        `,
        [
          String(body.name || ""),
          String(body.brand || ""),
          String(body.model || ""),
          Number(body.sell_price || 0),
          Number(body.min_stock || 1),
          id,
          user.shop_id
        ]
      );

      if (!result.rows.length) {
        send(res, 404, {
          success: false,
          error: "جنس پیدا نشد."
        });
        return;
      }

      send(res, 200, {
        success: true,
        product: result.rows[0]
      });

      return;
    }

    // PRODUCT DELETE
    const productDeleteMatch = path.match(/^\/products\/(\d+)$/);

    if (productDeleteMatch && method === "DELETE") {
      const user = await requireUser(req, res);

      if (!user) return;

      const id = Number(productDeleteMatch[1]);

      const result = await pool.query(
        `
        DELETE FROM products
        WHERE id = $1
        AND shop_id = $2
        RETURNING id
        `,
        [id, user.shop_id]
      );

      send(res, 200, {
        success: true,
        deleted: result.rows.length > 0
      });

      return;
    }

    // BUY
    if (path === "/buy" && method === "POST") {
      const user = await requireUser(req, res);

      if (!user) return;

      const body = await getBody(req);

      const productId = Number(body.product_id);
      const quantity = Number(body.quantity);
      const unitPrice = Number(body.unit_price);
      const currency =
        String(body.currency || "AFN").toUpperCase() === "USD"
          ? "USD"
          : "AFN";

      const rate =
        currency === "USD"
          ? Number(body.currency_rate || 0)
          : 1;

      if (!productId || quantity <= 0 || unitPrice <= 0) {
        send(res, 400, {
          success: false,
          error: "اطلاعات خرید صحیح نیست."
        });
        return;
      }

      if (currency === "USD" && rate <= 0) {
        send(res, 400, {
          success: false,
          error: "نرخ دالر را وارد کنید."
        });
        return;
      }

      const baseUnitPrice =
        currency === "USD"
          ? unitPrice * rate
          : unitPrice;

      const total = quantity * unitPrice;
      const baseTotal = quantity * baseUnitPrice;

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
          throw new Error("جنس پیدا نشد.");
        }

        const product = productResult.rows[0];

        const oldQty = Number(product.quantity || 0);
        const oldBuy = Number(product.buy_price || 0);

        const newQty = oldQty + quantity;

        const newAverageBuy =
          newQty > 0
            ? ((oldQty * oldBuy) + baseTotal) / newQty
            : baseUnitPrice;

        await client.query(
          `
          UPDATE products
          SET
            quantity = $1,
            buy_price = $2
          WHERE id = $3
          `,
          [
            newQty,
            newAverageBuy,
            productId
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
            baseTotal
          ]
        );

        await client.query("COMMIT");

        send(res, 200, {
          success: true,
          transaction: transaction.rows[0]
        });

      } catch (e) {
        await client.query("ROLLBACK");

        send(res, 400, {
          success: false,
          error: e.message
        });

      } finally {
        client.release();
      }

      return;
    }

    // SELL
    if (path === "/sell" && method === "POST") {
      const user = await requireUser(req, res);

      if (!user) return;

      const body = await getBody(req);

      const productId = Number(body.product_id);
      const quantity = Number(body.quantity);
      const unitPrice = Number(body.unit_price);

      const currency =
        String(body.currency || "AFN").toUpperCase() === "USD"
          ? "USD"
          : "AFN";

      const rate =
        currency === "USD"
          ? Number(body.currency_rate || 0)
          : 1;

      if (!productId || quantity <= 0 || unitPrice <= 0) {
        send(res, 400, {
          success: false,
          error: "اطلاعات فروش صحیح نیست."
        });
        return;
      }

      if (currency === "USD" && rate <= 0) {
        send(res, 400, {
          success: false,
          error: "نرخ دالر را وارد کنید."
        });
        return;
      }

      const baseUnitPrice =
        currency === "USD"
          ? unitPrice * rate
          : unitPrice;

      const total = quantity * unitPrice;
      const baseTotal = quantity * baseUnitPrice;

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
          throw new Error("جنس پیدا نشد.");
        }

        const product = productResult.rows[0];

        const oldQty = Number(product.quantity || 0);
        const averageBuy = Number(product.buy_price || 0);

        if (oldQty < quantity) {
          throw new Error(
            "موجودی کافی نیست. موجودی فعلی: " + oldQty
          );
        }

        const newQty = oldQty - quantity;

        const buyCost = quantity * averageBuy;

        // سود همیشه به AFN محاسبه می‌شود
        const profit = baseTotal - buyCost;

        await client.query(
          `
          UPDATE products
          SET quantity = $1
          WHERE id = $2
          `,
          [
            newQty,
            productId
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
            baseTotal
          ]
        );

        await client.query("COMMIT");

        send(res, 200, {
          success: true,
          transaction: transaction.rows[0],
          profit: profit
        });

      } catch (e) {
        await client.query("ROLLBACK");

        send(res, 400, {
          success: false,
          error: e.message
        });

      } finally {
        client.release();
      }

      return;
    }

    // TRANSACTIONS
    if (path === "/transactions" && method === "GET") {
      const user = await requireUser(req, res);

      if (!user) return;

      const result = await pool.query(
        `
        SELECT
          t.*,
          p.name AS product_name,
          p.brand,
          p.model,
          u.username
        FROM transactions t
        LEFT JOIN products p
          ON p.id = t.product_id
        LEFT JOIN users u
          ON u.id = t.user_id
        WHERE t.shop_id = $1
        ORDER BY t.id DESC
        `,
        [user.shop_id]
      );

      send(res, 200, {
        success: true,
        transactions: result.rows
      });

      return;
    }

    // SINGLE TRANSACTION / RECEIPT
    const transactionMatch = path.match(/^\/transactions\/(\d+)$/);

    if (transactionMatch && method === "GET") {
      const user = await requireUser(req, res);

      if (!user) return;

      const id = Number(transactionMatch[1]);

      const result = await pool.query(
        `
        SELECT
          t.*,
          p.name AS product_name,
          p.brand,
          p.model,
          s.name AS shop_name,
          s.owner_name,
          s.phone,
          s.address
        FROM transactions t
        LEFT JOIN products p
          ON p.id = t.product_id
        LEFT JOIN shops s
          ON s.id = t.shop_id
        WHERE t.id = $1
        AND t.shop_id = $2
        LIMIT 1
        `,
        [id, user.shop_id]
      );

      if (!result.rows.length) {
        send(res, 404, {
          success: false,
          error: "رسید پیدا نشد."
        });
        return;
      }

      send(res, 200, {
        success: true,
        transaction: result.rows[0]
      });

      return;
    }

    // WORKERS GET
    if (path === "/workers" && method === "GET") {
      const user = await requireUser(req, res);

      if (!user) return;

      const result = await pool.query(
        `
        SELECT id, shop_id, username, name, role, created_at
        FROM users
        WHERE shop_id = $1
        AND role = 'worker'
        ORDER BY id DESC
        `,
        [user.shop_id]
      );

      send(res, 200, {
        success: true,
        workers: result.rows
      });

      return;
    }

    // WORKER CREATE
    if (path === "/workers" && method === "POST") {
      const user = await requireUser(req, res);

      if (!user) return;

      if (user.role !== "owner") {
        send(res, 403, {
          success: false,
          error: "فقط صاحب دوکان می‌تواند کارمند اضافه کند."
        });
        return;
      }

      const body = await getBody(req);

      const name = String(body.name || "").trim();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (!name || !username || !password) {
        send(res, 400, {
          success: false,
          error: "تمام معلومات کارمند را وارد کنید."
        });
        return;
      }

      const exists = await pool.query(
        `SELECT id FROM users WHERE username = $1`,
        [username]
      );

      if (exists.rows.length) {
        send(res, 400, {
          success: false,
          error: "این نام کاربری قبلاً استفاده شده است."
        });
        return;
      }

      const result = await pool.query(
        `
        INSERT INTO users
        (shop_id, username, password, name, role)
        VALUES($1,$2,$3,$4,'worker')
        RETURNING id, shop_id, username, name, role, created_at
        `,
        [
          user.shop_id,
          username,
          hashPassword(password),
          name
        ]
      );

      send(res, 200, {
        success: true,
        worker: result.rows[0]
      });

      return;
    }

    // WORKER DELETE
    const workerDeleteMatch = path.match(/^\/workers\/(\d+)$/);

    if (workerDeleteMatch && method === "DELETE") {
      const user = await requireUser(req, res);

      if (!user) return;

      if (user.role !== "owner") {
        send(res, 403, {
          success: false,
          error: "فقط صاحب دوکان می‌تواند کارمند حذف کند."
        });
        return;
      }

      const id = Number(workerDeleteMatch[1]);

      await pool.query(
        `
        DELETE FROM users
        WHERE id = $1
        AND shop_id = $2
        AND role = 'worker'
        `,
        [id, user.shop_id]
      );

      send(res, 200, {
        success: true
      });

      return;
    }

    // DASHBOARD
    if (path === "/dashboard" && method === "GET") {
      const user = await requireUser(req, res);

      if (!user) return;

      const summary = await pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE type = 'buy') AS purchase_count,
          COUNT(*) FILTER (WHERE type = 'sell') AS sale_count,

          COALESCE(
            SUM(base_total) FILTER (WHERE type = 'buy'),
            0
          ) AS purchases_total_afn,

          COALESCE(
            SUM(base_total) FILTER (WHERE type = 'sell'),
            0
          ) AS sales_total_afn,

          COALESCE(
            SUM(profit) FILTER (WHERE type = 'sell'),
            0
          ) AS profit_total_afn,

          COALESCE(
            SUM(total) FILTER (
              WHERE type = 'buy' AND currency = 'AFN'
            ),
            0
          ) AS purchases_afn,

          COALESCE(
            SUM(total) FILTER (
              WHERE type = 'buy' AND currency = 'USD'
            ),
            0
          ) AS purchases_usd,

          COALESCE(
            SUM(total) FILTER (
              WHERE type = 'sell' AND currency = 'AFN'
            ),
            0
          ) AS sales_afn,

          COALESCE(
            SUM(total) FILTER (
              WHERE type = 'sell' AND currency = 'USD'
            ),
            0
          ) AS sales_usd

        FROM transactions
        WHERE shop_id = $1
        `,
        [user.shop_id]
      );

      const productsCount = await pool.query(
        `
        SELECT
          COUNT(*) AS products_count,
          COALESCE(
            SUM(quantity),
            0
          ) AS total_stock
        FROM products
        WHERE shop_id = $1
        `,
        [user.shop_id]
      );

      const lowStock = await pool.query(
        `
        SELECT COUNT(*) AS low_stock_count
        FROM products
        WHERE shop_id = $1
        AND quantity <= min_stock
        `,
        [user.shop_id]
      );

      const row = summary.rows[0];
      const pc = productsCount.rows[0];
      const low = lowStock.rows[0];

      send(res, 200, {
        success: true,

        dashboard: {
          // تعداد عملیات
          purchase_count: Number(row.purchase_count || 0),
          sale_count: Number(row.sale_count || 0),

          // مبالغ پایه AFN
          purchases_total_afn: Number(
            row.purchases_total_afn || 0
          ),

          sales_total_afn: Number(
            row.sales_total_afn || 0
          ),

          profit_total_afn: Number(
            row.profit_total_afn || 0
          ),

          // مبالغ اصلی هر ارز
          purchases_afn: Number(
            row.purchases_afn || 0
          ),

          purchases_usd: Number(
            row.purchases_usd || 0
          ),

          sales_afn: Number(
            row.sales_afn || 0
          ),

          sales_usd: Number(
            row.sales_usd || 0
          ),

          // موجودی
          products_count: Number(
            pc.products_count || 0
          ),

          total_stock: Number(
            pc.total_stock || 0
          ),

          low_stock_count: Number(
            low.low_stock_count || 0
          )
        }
      });

      return;
    }

    send(res, 404, {
      success: false,
      error: "Endpoint not found"
    });

  } catch (error) {
    console.error(error);

    send(res, 500, {
      success: false,
      error: error.message || "خطای سرور"
    });
  }
}

module.exports = async function(req, res) {
  await handle(req, res);
};