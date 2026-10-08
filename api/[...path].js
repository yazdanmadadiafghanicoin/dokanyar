const { Pool } = require("pg");
const crypto = require("crypto");

// ===============================
// CORS
// ===============================
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
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ===============================
// DATABASE
// ===============================
let pool = null;

function getPool() {
  if (pool) return pool;

  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (!url) {
    throw new Error("DATABASE_URL پیدا نشد.");
  }

  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  return pool;
}

// ===============================
// HELPERS
// ===============================
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

async function body(req) {
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
      } catch {
        resolve({});
      }
    });
  });
}

// ===============================
// DATABASE SETUP
// ===============================
async function setupDatabase() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'worker',
      token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_shop_username_unique
    ON users(shop_id, username)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
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
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(18,2) DEFAULT 0,
      total NUMERIC(18,2) DEFAULT 0,
      buy_cost NUMERIC(18,2) DEFAULT 0,
      profit NUMERIC(18,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  return true;
}

// ===============================
// AUTH
// ===============================
async function auth(req) {
  const token = getToken(req);

  if (!token) {
    return null;
  }

  const db = getPool();

  const result = await db.query(
    `
    SELECT
      u.id,
      u.shop_id,
      u.username,
      u.full_name,
      u.role,
      s.name AS shop_name,
      s.owner_name
    FROM users u
    JOIN shops s ON s.id = u.shop_id
    WHERE u.token = $1
    LIMIT 1
    `,
    [token]
  );

  return result.rows[0] || null;
}

function requireAuth(user, res) {
  if (!user) {
    send(res, 401, {
      success: false,
      error: "لطفاً وارد حساب شوید.",
    });

    return false;
  }

  return true;
}

// ===============================
// MAIN HANDLER
// ===============================
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

    let pathname = parsed.pathname;

    // /api/[...path]
    if (pathname.startsWith("/api")) {
      pathname = pathname.substring(4);
    }

    if (!pathname) pathname = "/";

    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    const method = req.method.toUpperCase();

    // =========================================
    // API ROOT
    // =========================================
    if (method === "GET" && pathname === "/") {
      return send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: true,
      });
    }

    // =========================================
    // SETUP
    // =========================================
    if (
      (method === "GET" || method === "POST") &&
      pathname === "/setup"
    ) {
      return send(res, 200, {
        success: true,
        message: "Database is ready.",
        database: true,
      });
    }

    // =========================================
    // REGISTER
    // =========================================
    if (method === "POST" && pathname === "/register") {
      const data = await body(req);

      const shopName = String(data.shop_name || "").trim();
      const ownerName = String(data.owner_name || "").trim();
      const username = String(data.username || "").trim();
      const password = String(data.password || "");

      if (!shopName || !username || password.length < 4) {
        return send(res, 400, {
          success: false,
          error: "نام دوکان، نام کاربری و رمز حداقل ۴ حرف لازم است.",
        });
      }

      const db = getPool();

      const exists = await db.query(
        `SELECT id FROM users WHERE username = $1 LIMIT 1`,
        [username]
      );

      if (exists.rows.length) {
        return send(res, 409, {
          success: false,
          error: "این نام کاربری قبلاً استفاده شده است.",
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const shopResult = await client.query(
          `
          INSERT INTO shops(name, owner_name)
          VALUES($1,$2)
          RETURNING id
          `,
          [shopName, ownerName]
        );

        const shopId = shopResult.rows[0].id;
        const token = makeToken();

        const userResult = await client.query(
          `
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
          `,
          [
            shopId,
            username,
            hashPassword(password),
            ownerName,
            token,
          ]
        );

        await client.query("COMMIT");

        return send(res, 201, {
          success: true,
          message: "دوکان با موفقیت ثبت شد.",
          token,
          user: userResult.rows[0],
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // =========================================
    // LOGIN
    // =========================================
    if (method === "POST" && pathname === "/login") {
      const data = await body(req);

      const username = String(data.username || "").trim();
      const password = String(data.password || "");

      if (!username || !password) {
        return send(res, 400, {
          success: false,
          error: "نام کاربری و رمز عبور را وارد کنید.",
        });
      }

      const db = getPool();

      const result = await db.query(
        `
        SELECT
          u.id,
          u.shop_id,
          u.username,
          u.full_name,
          u.role,
          s.name AS shop_name,
          s.owner_name
        FROM users u
        JOIN shops s ON s.id = u.shop_id
        WHERE u.username = $1
          AND u.password_hash = $2
        LIMIT 1
        `,
        [username, hashPassword(password)]
      );

      if (!result.rows.length) {
        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است.",
        });
      }

      const user = result.rows[0];
      const token = makeToken();

      await db.query(
        `UPDATE users SET token = $1 WHERE id = $2`,
        [token, user.id]
      );

      return send(res, 200, {
        success: true,
        message: "ورود موفق بود.",
        token,
        user,
      });
    }

    // =========================================
    // LOGOUT
    // =========================================
    if (method === "POST" && pathname === "/logout") {
      const user = await auth(req);

      if (user) {
        const db = getPool();

        await db.query(
          `UPDATE users SET token = NULL WHERE id = $1`,
          [user.id]
        );
      }

      return send(res, 200, {
        success: true,
        message: "خارج شدید.",
      });
    }

    // =========================================
    // ME
    // =========================================
    if (method === "GET" && pathname === "/me") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      return send(res, 200, {
        success: true,
        user,
      });
    }

    // =========================================
    // SHOP
    // =========================================
    if (pathname === "/shop") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const db = getPool();

      if (method === "GET") {
        const result = await db.query(
          `
          SELECT id, name, owner_name, created_at
          FROM shops
          WHERE id = $1
          `,
          [user.shop_id]
        );

        return send(res, 200, {
          success: true,
          shop: result.rows[0] || null,
        });
      }

      if (method === "PUT") {
        if (user.role !== "owner") {
          return send(res, 403, {
            success: false,
            error: "فقط صاحب دوکان اجازه تغییر تنظیمات را دارد.",
          });
        }

        const data = await body(req);

        const name = String(data.name || "").trim();
        const ownerName = String(data.owner_name || "").trim();

        const result = await db.query(
          `
          UPDATE shops
          SET name = $1,
              owner_name = $2
          WHERE id = $3
          RETURNING id, name, owner_name
          `,
          [name || user.shop_name, ownerName, user.shop_id]
        );

        return send(res, 200, {
          success: true,
          shop: result.rows[0],
        });
      }
    }

    // =========================================
    // PRODUCTS
    // =========================================
    if (pathname === "/products") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const db = getPool();

      if (method === "GET") {
        const result = await db.query(
          `
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
          `,
          [user.shop_id]
        );

        return send(res, 200, {
          success: true,
          products: result.rows,
        });
      }

      if (method === "POST") {
        const data = await body(req);

        const name = String(data.name || "").trim();
        const brand = String(data.brand || "").trim();
        const model = String(data.model || "").trim();

        const buyPrice = Number(data.buy_price || 0);
        const sellPrice = Number(data.sell_price || 0);
        const quantity = Math.max(0, Number(data.quantity || 0));

        if (!name) {
          return send(res, 400, {
            success: false,
            error: "نام محصول لازم است.",
          });
        }

        const result = await db.query(
          `
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

        return send(res, 201, {
          success: true,
          product: result.rows[0],
        });
      }
    }

    // =========================================
    // PRODUCT BY ID
    // =========================================
    const productMatch = pathname.match(/^\/products\/(\d+)$/);

    if (productMatch) {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const productId = Number(productMatch[1]);
      const db = getPool();

      if (method === "PUT") {
        const data = await body(req);

        const result = await db.query(
          `
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
          `,
          [
            String(data.name || "").trim(),
            String(data.brand || "").trim(),
            String(data.model || "").trim(),
            Number(data.buy_price || 0),
            Number(data.sell_price || 0),
            Math.max(0, Number(data.quantity || 0)),
            productId,
            user.shop_id,
          ]
        );

        if (!result.rows.length) {
          return send(res, 404, {
            success: false,
            error: "محصول پیدا نشد.",
          });
        }

        return send(res, 200, {
          success: true,
          product: result.rows[0],
        });
      }

      if (method === "DELETE") {
        const result = await db.query(
          `
          DELETE FROM products
          WHERE id = $1
            AND shop_id = $2
          RETURNING id
          `,
          [productId, user.shop_id]
        );

        if (!result.rows.length) {
          return send(res, 404, {
            success: false,
            error: "محصول پیدا نشد.",
          });
        }

        return send(res, 200, {
          success: true,
          message: "محصول حذف شد.",
        });
      }
    }

    // =========================================
    // BUY
    // Weighted Average Cost
    // =========================================
    if (method === "POST" && pathname === "/buy") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const data = await body(req);

      const productId = Number(data.product_id);
      const quantity = Number(data.quantity);
      const unitPrice = Number(data.unit_price);

      if (
        !productId ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(unitPrice) ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "اطلاعات خرید نادرست است.",
        });
      }

      const db = getPool();
      const client = await db.connect();

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
          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "محصول پیدا نشد.",
          });
        }

        const product = productResult.rows[0];

        const oldStock = Number(product.quantity || 0);
        const oldBuy = Number(product.buy_price || 0);

        const newStock = oldStock + quantity;

        const newAverageBuy =
          newStock > 0
            ? ((oldStock * oldBuy) +
                (quantity * unitPrice)) /
              newStock
            : unitPrice;

        await client.query(
          `
          UPDATE products
          SET
            quantity = $1,
            buy_price = $2,
            updated_at = NOW()
          WHERE id = $3
          `,
          [
            newStock,
            newAverageBuy,
            productId,
          ]
        );

        const total = quantity * unitPrice;

        const transactionResult = await client.query(
          `
          INSERT INTO transactions(
            shop_id,
            product_id,
            user_id,
            type,
            quantity,
            unit_price,
            total,
            buy_cost,
            profit
          )
          VALUES($1,$2,$3,'buy',$4,$5,$6,$6,0)
          RETURNING *
          `,
          [
            user.shop_id,
            productId,
            user.id,
            quantity,
            unitPrice,
            total,
          ]
        );

        await client.query("COMMIT");

        return send(res, 200, {
          success: true,
          message: "خرید ثبت شد.",
          product: {
            id: productId,
            quantity: newStock,
            average_buy_price: newAverageBuy,
          },
          transaction: transactionResult.rows[0],
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // =========================================
    // SELL
    // =========================================
    if (method === "POST" && pathname === "/sell") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const data = await body(req);

      const productId = Number(data.product_id);
      const quantity = Number(data.quantity);
      const unitPrice = Number(data.unit_price);

      if (
        !productId ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(unitPrice) ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "اطلاعات فروش نادرست است.",
        });
      }

      const db = getPool();
      const client = await db.connect();

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
          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "محصول پیدا نشد.",
          });
        }

        const product = productResult.rows[0];

        const stock = Number(product.quantity || 0);
        const averageBuy = Number(product.buy_price || 0);

        if (quantity > stock) {
          await client.query("ROLLBACK");

          return send(res, 400, {
            success: false,
            error: `موجودی کافی نیست. موجودی فعلی: ${stock}`,
          });
        }

        const total = quantity * unitPrice;
        const buyCost = quantity * averageBuy;
        const profit = total - buyCost;
        const newStock = stock - quantity;

        await client.query(
          `
          UPDATE products
          SET
            quantity = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [newStock, productId]
        );

        const transactionResult = await client.query(
          `
          INSERT INTO transactions(
            shop_id,
            product_id,
            user_id,
            type,
            quantity,
            unit_price,
            total,
            buy_cost,
            profit
          )
          VALUES($1,$2,$3,'sell',$4,$5,$6,$7,$8)
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
          ]
        );

        await client.query("COMMIT");

        return send(res, 200, {
          success: true,
          message: "فروش ثبت شد.",
          product: {
            id: productId,
            quantity: newStock,
            average_buy_price: averageBuy,
          },
          transaction: transactionResult.rows[0],
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // =========================================
    // TRANSACTIONS
    // =========================================
    if (method === "GET" && pathname === "/transactions") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const db = getPool();

      const result = await db.query(
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

      return send(res, 200, {
        success: true,
        transactions: result.rows,
      });
    }

    // =========================================
    // WORKERS
    // =========================================
    if (pathname === "/workers") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const db = getPool();

      if (method === "GET") {
        const result = await db.query(
          `
          SELECT
            id,
            username,
            full_name,
            role,
            created_at
          FROM users
          WHERE shop_id = $1
          ORDER BY id DESC
          `,
          [user.shop_id]
        );

        return send(res, 200, {
          success: true,
          workers: result.rows,
        });
      }

      if (method === "POST") {
        if (user.role !== "owner") {
          return send(res, 403, {
            success: false,
            error: "فقط صاحب دوکان می‌تواند کارمند اضافه کند.",
          });
        }

        const data = await body(req);

        const username = String(data.username || "").trim();
        const password = String(data.password || "");
        const fullName = String(data.full_name || "").trim();

        if (!username || password.length < 4) {
          return send(res, 400, {
            success: false,
            error: "نام کاربری و رمز حداقل ۴ حرف لازم است.",
          });
        }

        const exists = await db.query(
          `
          SELECT id
          FROM users
          WHERE shop_id = $1
            AND username = $2
          `,
          [user.shop_id, username]
        );

        if (exists.rows.length) {
          return send(res, 409, {
            success: false,
            error: "این کاربر قبلاً وجود دارد.",
          });
        }

        const result = await db.query(
          `
          INSERT INTO users(
            shop_id,
            username,
            password_hash,
            full_name,
            role
          )
          VALUES($1,$2,$3,$4,'worker')
          RETURNING id, username, full_name, role
          `,
          [
            user.shop_id,
            username,
            hashPassword(password),
            fullName,
          ]
        );

        return send(res, 201, {
          success: true,
          worker: result.rows[0],
        });
      }
    }

    // =========================================
    // DELETE WORKER
    // =========================================
    const workerMatch = pathname.match(/^\/workers\/(\d+)$/);

    if (workerMatch && method === "DELETE") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      if (user.role !== "owner") {
        return send(res, 403, {
          success: false,
          error: "فقط صاحب دوکان اجازه حذف کارمند را دارد.",
        });
      }

      const workerId = Number(workerMatch[1]);
      const db = getPool();

      const result = await db.query(
        `
        DELETE FROM users
        WHERE id = $1
          AND shop_id = $2
          AND role = 'worker'
        RETURNING id
        `,
        [workerId, user.shop_id]
      );

      if (!result.rows.length) {
        return send(res, 404, {
          success: false,
          error: "کارمند پیدا نشد.",
        });
      }

      return send(res, 200, {
        success: true,
        message: "کارمند حذف شد.",
      });
    }

    // =========================================
    // DASHBOARD
    // =========================================
    if (method === "GET" && pathname === "/dashboard") {
      const user = await auth(req);

      if (!requireAuth(user, res)) return;

      const db = getPool();

      const products = await db.query(
        `
        SELECT
          COUNT(*)::int AS product_count,
          COALESCE(SUM(quantity),0)::int AS total_quantity,
          COALESCE(SUM(quantity * buy_price),0)::numeric AS inventory_cost,
          COALESCE(SUM(quantity * sell_price),0)::numeric AS inventory_value
        FROM products
        WHERE shop_id = $1
        `,
        [user.shop_id]
      );

      const sales = await db.query(
        `
        SELECT
          COALESCE(SUM(total),0)::numeric AS sales_total,
          COALESCE(SUM(profit),0)::numeric AS profit_total,
          COUNT(*)::int AS sales_count
        FROM transactions
        WHERE shop_id = $1
          AND type = 'sell'
        `,
        [user.shop_id]
      );

      const purchases = await db.query(
        `
        SELECT
          COALESCE(SUM(total),0)::numeric AS purchases_total,
          COUNT(*)::int AS purchases_count
        FROM transactions
        WHERE shop_id = $1
          AND type = 'buy'
        `,
        [user.shop_id]
      );

      const lowStock = await db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM products
        WHERE shop_id = $1
          AND quantity <= 3
        `,
        [user.shop_id]
      );

      return send(res, 200, {
        success: true,
        dashboard: {
          products: products.rows[0],
          sales: sales.rows[0],
          purchases: purchases.rows[0],
          low_stock: lowStock.rows[0],
        },
      });
    }

    // =========================================
    // 404
    // =========================================
    return send(res, 404, {
      success: false,
      error: "Endpoint not found",
      path: pathname,
      method,
    });
  } catch (error) {
    console.error("DOKANYAAR API ERROR:", error);

    return send(res, 500, {
      success: false,
      error: error.message || "خطای داخلی سرور",
    });
  }
};