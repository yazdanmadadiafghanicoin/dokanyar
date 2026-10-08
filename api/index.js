const { Pool } = require("pg");
const crypto = require("crypto");

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL در Vercel تنظیم نشده است.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10
    });
  }

  return pool;
}

function send(res, status, data) {
  return res.status(status).json(data);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function txt(v) {
  return String(v ?? "").trim();
}

/* ================= PASSWORD ================= */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split(":");

    if (parts.length !== 2) return false;

    const salt = parts[0];
    const original = Buffer.from(parts[1], "hex");

    const hash = crypto.scryptSync(password, salt, 64);

    return (
      original.length === hash.length &&
      crypto.timingSafeEqual(original, hash)
    );
  } catch {
    return false;
  }
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* ================= AUTH ================= */

async function getUser(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const token = auth.slice(7).trim();

  if (!token) return null;

  const db = getPool();

  const result = await db.query(`
    SELECT
      u.id,
      u.shop_id,
      u.username,
      u.full_name,
      u.role,
      s.name AS shop_name
    FROM sessions se
    JOIN users u ON u.id = se.user_id
    JOIN shops s ON s.id = u.shop_id
    WHERE se.token = $1
      AND se.expires_at > NOW()
      AND u.active = TRUE
    LIMIT 1
  `, [token]);

  return result.rows[0] || null;
}

function requireUser(user, res) {
  if (!user) {
    send(res, 401, {
      success: false,
      error: "ورود لازم است."
    });

    return false;
  }

  return true;
}

function requireOwner(user, res) {
  if (!requireUser(user, res)) return false;

  if (user.role !== "owner") {
    send(res, 403, {
      success: false,
      error: "فقط صاحب دوکان اجازه این کار را دارد."
    });

    return false;
  }

  return true;
}

/* ================= DATABASE ================= */

async function setup() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_name TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'worker'
        CHECK (role IN ('owner','worker')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, username)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brand TEXT DEFAULT '',
      model TEXT DEFAULT '',
      buy_price NUMERIC(18,2) NOT NULL DEFAULT 0,
      sell_price NUMERIC(18,2) NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK (type IN ('buy','sell')),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
      buy_price NUMERIC(18,2) NOT NULL DEFAULT 0,
      total NUMERIC(18,2) NOT NULL DEFAULT 0,
      profit NUMERIC(18,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS products_shop_idx
    ON products(shop_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS transactions_shop_idx
    ON transactions(shop_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS transactions_date_idx
    ON transactions(created_at);
  `);
}

/* ================= HANDLER ================= */

module.exports = async function handler(req, res) {
  try {
    await setup();

    const method = req.method || "GET";

    const url = new URL(
      req.url,
      `https://${req.headers.host || "localhost"}`
    );

    const path =
      url.pathname.replace(/^\/api/, "") || "/";

    const body = req.body || {};
    const db = getPool();

    /* ================= HEALTH ================= */

    if (path === "/" && method === "GET") {
      return send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: Boolean(process.env.DATABASE_URL)
      });
    }

    /* ================= SETUP ================= */

    if (
      path === "/setup" &&
      (method === "GET" || method === "POST")
    ) {
      return send(res, 200, {
        success: true,
        message: "دیتابیس آماده است."
      });
    }

    /* ================= REGISTER ================= */

    if (path === "/register" && method === "POST") {
      const shopName = txt(body.shop_name);
      const ownerName = txt(body.owner_name);
      const username = txt(body.username);
      const password = String(body.password || "");

      if (!shopName) {
        return send(res, 400, {
          success: false,
          error: "نام دوکان الزامی است."
        });
      }

      if (username.length < 3) {
        return send(res, 400, {
          success: false,
          error: "نام کاربری حداقل ۳ حرف باشد."
        });
      }

      if (password.length < 6) {
        return send(res, 400, {
          success: false,
          error: "رمز عبور حداقل ۶ کاراکتر باشد."
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const shop = await client.query(`
          INSERT INTO shops
          (name, owner_name)
          VALUES ($1,$2)
          RETURNING *
        `, [shopName, ownerName]);

        const user = await client.query(`
          INSERT INTO users
          (
            shop_id,
            username,
            password_hash,
            full_name,
            role
          )
          VALUES ($1,$2,$3,$4,'owner')
          RETURNING id,username,full_name,role
        `, [
          shop.rows[0].id,
          username,
          hashPassword(password),
          ownerName
        ]);

        await client.query("COMMIT");

        return send(res, 201, {
          success: true,
          message: "دوکان ثبت شد.",
          shop: shop.rows[0],
          user: user.rows[0]
        });

      } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
          return send(res, 409, {
            success: false,
            error: "این نام کاربری قبلاً استفاده شده است."
          });
        }

        throw error;

      } finally {
        client.release();
      }
    }

    /* ================= LOGIN ================= */

    if (path === "/login" && method === "POST") {
      const username = txt(body.username);
      const password = String(body.password || "");

      const result = await db.query(`
        SELECT *
        FROM users
        WHERE username = $1
          AND active = TRUE
        ORDER BY id
        LIMIT 1
      `, [username]);

      if (!result.rows.length) {
        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
      }

      const user = result.rows[0];

      if (!verifyPassword(password, user.password_hash)) {
        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
      }

      const token = makeToken();

      await db.query(`
        INSERT INTO sessions
        (user_id,token,expires_at)
        VALUES
        ($1,$2,NOW() + INTERVAL '30 days')
      `, [user.id, token]);

      const shop = await db.query(`
        SELECT *
        FROM shops
        WHERE id = $1
      `, [user.shop_id]);

      return send(res, 200, {
        success: true,
        token,
        user: {
          id: user.id,
          shop_id: user.shop_id,
          username: user.username,
          full_name: user.full_name,
          role: user.role
        },
        shop: shop.rows[0]
      });
    }

    /* ================= ME ================= */

    if (path === "/me" && method === "GET") {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      return send(res, 200, {
        success: true,
        user
      });
    }

    /* ================= LOGOUT ================= */

    if (path === "/logout" && method === "POST") {
      const auth = req.headers.authorization || "";

      if (auth.startsWith("Bearer ")) {
        await db.query(`
          DELETE FROM sessions
          WHERE token = $1
        `, [auth.slice(7).trim()]);
      }

      return send(res, 200, {
        success: true,
        message: "خروج انجام شد."
      });
    }

    /* ================= PRODUCTS ================= */

    if (path === "/products" && method === "GET") {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      const search = txt(
        url.searchParams.get("search")
      );

      const result = search
        ? await db.query(`
            SELECT *
            FROM products
            WHERE shop_id = $1
              AND (
                name ILIKE $2
                OR brand ILIKE $2
                OR model ILIKE $2
              )
            ORDER BY id DESC
          `, [
            user.shop_id,
            `%${search}%`
          ])
        : await db.query(`
            SELECT *
            FROM products
            WHERE shop_id = $1
            ORDER BY id DESC
          `, [user.shop_id]);

      return send(res, 200, {
        success: true,
        products: result.rows
      });
    }

    /* ================= CREATE PRODUCT ================= */

    if (path === "/products" && method === "POST") {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      const name = txt(body.name);
      const brand = txt(body.brand);
      const model = txt(body.model);

      const buyPrice = num(body.buy_price);
      const sellPrice = num(body.sell_price);
      const stock = num(body.stock ?? 0);

      if (!name) {
        return send(res, 400, {
          success: false,
          error: "نام کالا الزامی است."
        });
      }

      if (
        buyPrice === null ||
        buyPrice < 0 ||
        sellPrice === null ||
        sellPrice < 0 ||
        stock === null ||
        !Number.isInteger(stock) ||
        stock < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "اطلاعات کالا نامعتبر است."
        });
      }

      const result = await db.query(`
        INSERT INTO products
        (
          shop_id,
          name,
          brand,
          model,
          buy_price,
          sell_price,
          stock
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *
      `, [
        user.shop_id,
        name,
        brand,
        model,
        buyPrice,
        sellPrice,
        stock
      ]);

      return send(res, 201, {
        success: true,
        product: result.rows[0]
      });
    }

    /* ================= BUY ================= */

    if (path === "/buy" && method === "POST") {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      const productId = num(body.product_id);
      const quantity = num(body.quantity);
      const unitPrice = num(body.unit_price);

      if (
        !Number.isInteger(productId) ||
        productId <= 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        unitPrice === null ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "اطلاعات خرید نامعتبر است."
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(`
          SELECT *
          FROM products
          WHERE id = $1
            AND shop_id = $2
          FOR UPDATE
        `, [
          productId,
          user.shop_id
        ]);

        if (!result.rows.length) {
          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "کالا پیدا نشد."
          });
        }

        const product = result.rows[0];

        /*
          میانگین موزون قیمت خرید:

          ارزش موجودی قبلی =
          موجودی قبلی × قیمت خرید قبلی

          ارزش خرید جدید =
          تعداد خرید × قیمت جدید

          قیمت خرید جدید =
          مجموع ارزش / مجموع تعداد
        */

        const oldStock = Number(product.stock || 0);
        const oldBuyPrice = Number(product.buy_price || 0);

        const newStock = oldStock + quantity;

        const newBuyPrice =
          newStock > 0
            ? (
                (
                  oldStock * oldBuyPrice
                ) +
                (
                  quantity * unitPrice
                )
              ) / newStock
            : unitPrice;

        const total = quantity * unitPrice;

        await client.query(`
          UPDATE products
          SET
            stock = $1,
            buy_price = $2,
            updated_at = NOW()
          WHERE id = $3
            AND shop_id = $4
        `, [
          newStock,
          newBuyPrice,
          productId,
          user.shop_id
        ]);

        await client.query(`
          INSERT INTO transactions
          (
            shop_id,
            product_id,
            user_id,
            type,
            quantity,
            unit_price,
            buy_price,
            total,
            profit
          )
          VALUES
          ($1,$2,$3,'buy',$4,$5,$6,$7,0)
        `, [
          user.shop_id,
          productId,
          user.id,
          quantity,
          unitPrice,
          newBuyPrice,
          total
        ]);

        await client.query("COMMIT");

        return send(res, 200, {
          success: true,
          message: "خرید ثبت شد.",
          total,
          average_buy_price: newBuyPrice,
          stock: newStock
        });

      } catch (error) {
        await client.query("ROLLBACK");
        throw error;

      } finally {
        client.release();
      }
    }

    /* ================= SELL ================= */

    if (path === "/sell" && method === "POST") {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      const productId = num(body.product_id);
      const quantity = num(body.quantity);
      const unitPrice = num(body.unit_price);

      if (
        !Number.isInteger(productId) ||
        productId <= 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        unitPrice === null ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "اطلاعات فروش نامعتبر است."
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(`
          SELECT *
          FROM products
          WHERE id = $1
            AND shop_id = $2
          FOR UPDATE
        `, [
          productId,
          user.shop_id
        ]);

        if (!result.rows.length) {
          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "کالا پیدا نشد."
          });
        }

        const product = result.rows[0];

        const stock = Number(product.stock || 0);

        if (stock < quantity) {
          await client.query("ROLLBACK");

          return send(res, 400, {
            success: false,
            error:
              `موجودی کافی نیست. موجودی فعلی: ${stock}`
          });
        }

        /*
          قیمت تمام شده واقعی هر واحد
          = میانگین موزون خرید فعلی
        */

        const costPrice =
          Number(product.buy_price || 0);

        const total =
          quantity * unitPrice;

        const cost =
          quantity * costPrice;

        const profit =
          total - cost;

        const newStock =
          stock - quantity;

        await client.query(`
          UPDATE products
          SET
            stock = $1,
            updated_at = NOW()
          WHERE id = $2
            AND shop_id = $3
        `, [
          newStock,
          productId,
          user.shop_id
        ]);

        await client.query(`
          INSERT INTO transactions
          (
            shop_id,
            product_id,
            user_id,
            type,
            quantity,
            unit_price,
            buy_price,
            total,
            profit
          )
          VALUES
          ($1,$2,$3,'sell',$4,$5,$6,$7,$8)
        `, [
          user.shop_id,
          productId,
          user.id,
          quantity,
          unitPrice,
          costPrice,
          total,
          profit
        ]);

        await client.query("COMMIT");

        return send(res, 200, {
          success: true,
          message: "فروش ثبت شد.",
          total,
          cost,
          profit,
          stock: newStock
        });

      } catch (error) {
        await client.query("ROLLBACK");
        throw error;

      } finally {
        client.release();
      }
    }

    /* ================= TRANSACTIONS ================= */

    if (
      path === "/transactions" &&
      method === "GET"
    ) {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      const result = await db.query(`
        SELECT
          t.id,
          t.type,
          t.quantity,
          t.unit_price,
          t.buy_price,
          t.total,
          t.profit,
          t.created_at,
          p.name AS product_name,
          u.username
        FROM transactions t
        JOIN products p
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

    /* ================= DASHBOARD ================= */

    if (
      path === "/dashboard" &&
      method === "GET"
    ) {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      const productStats = await db.query(`
        SELECT
          COUNT(*)::INTEGER AS product_count,
          COALESCE(SUM(stock),0)::INTEGER AS total_stock,
          COALESCE(
            SUM(stock * buy_price),0
          )::NUMERIC AS stock_value
        FROM products
        WHERE shop_id = $1
      `, [user.shop_id]);

      /*
        مهم:
        فقط تراکنش‌های SELL
        در سود حساب می‌شوند.
      */

      const today = await db.query(`
        SELECT
          COALESCE(SUM(total),0)::NUMERIC
            AS today_sales,

          COALESCE(SUM(profit),0)::NUMERIC
            AS today_profit

        FROM transactions

        WHERE shop_id = $1
          AND type = 'sell'
          AND created_at >= CURRENT_DATE
      `, [user.shop_id]);

      const allProfit = await db.query(`
        SELECT
          COALESCE(SUM(total),0)::NUMERIC
            AS total_sales,

          COALESCE(SUM(profit),0)::NUMERIC
            AS total_profit

        FROM transactions

        WHERE shop_id = $1
          AND type = 'sell'
      `, [user.shop_id]);

      const lowStock = await db.query(`
        SELECT
          id,
          name,
          brand,
          model,
          stock,
          sell_price,
          buy_price
        FROM products
        WHERE shop_id = $1
          AND stock <= 3
        ORDER BY stock ASC
        LIMIT 50
      `, [user.shop_id]);

      return send(res, 200, {
        success: true,

        dashboard: {
          products: productStats.rows[0],

          today: today.rows[0],

          all_time: allProfit.rows[0],

          low_stock: lowStock.rows
        }
      });
    }

    /* ================= SHOP ================= */

    if (
      path === "/shop" &&
      method === "GET"
    ) {
      const user = await getUser(req);

      if (!requireUser(user, res)) return;

      const result = await db.query(`
        SELECT *
        FROM shops
        WHERE id = $1
      `, [user.shop_id]);

      return send(res, 200, {
        success: true,
        shop: result.rows[0]
      });
    }

    /* ================= WORKERS ================= */

    if (
      path === "/workers" &&
      method === "GET"
    ) {
      const user = await getUser(req);

      if (!requireOwner(user, res)) return;

      const result = await db.query(`
        SELECT
          id,
          username,
          full_name,
          role,
          active,
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

    if (
      path === "/workers" &&
      method === "POST"
    ) {
      const user = await getUser(req);

      if (!requireOwner(user, res)) return;

      const username = txt(body.username);
      const password = String(body.password || "");
      const fullName = txt(body.full_name);

      if (username.length < 3) {
        return send(res, 400, {
          success: false,
          error: "نام کاربری نامعتبر است."
        });
      }

      if (password.length < 6) {
        return send(res, 400, {
          success: false,
          error: "رمز باید حداقل ۶ کاراکتر باشد."
        });
      }

      try {
        const result = await db.query(`
          INSERT INTO users
          (
            shop_id,
            username,
            password_hash,
            full_name,
            role
          )
          VALUES
          ($1,$2,$3,$4,'worker')
          RETURNING
            id,
            username,
            full_name,
            role,
            active
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

      } catch (error) {
        if (error.code === "23505") {
          return send(res, 409, {
            success: false,
            error: "این نام کاربری قبلاً وجود دارد."
          });
        }

        throw error;
      }
    }

    /* ================= NOT FOUND ================= */

    return send(res, 404, {
      success: false,
      error: "Endpoint not found."
    });

  } catch (error) {
    console.error("DOKANYAAR ERROR:", error);

    return send(res, 500, {
      success: false,
      error: error.message || "خطای داخلی سرور"
    });
  }
};