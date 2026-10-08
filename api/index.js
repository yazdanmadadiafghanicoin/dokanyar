const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-auth-token");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function send(res, status, data) {
  cors(res);
  res.status(status).json(data);
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.substring(7);
  return req.headers["x-auth-token"] || "";
}

async function db() {
  return pool;
}

async function setupDatabase() {
  const p = await db();

  await p.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker',
      token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brand TEXT DEFAULT '',
      model TEXT DEFAULT '',
      buy_price NUMERIC(18,2) DEFAULT 0,
      sell_price NUMERIC(18,2) DEFAULT 0,
      quantity NUMERIC(18,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      quantity NUMERIC(18,2) NOT NULL,
      unit_price NUMERIC(18,2) NOT NULL,
      total NUMERIC(18,2) NOT NULL,
      buy_cost NUMERIC(18,2) DEFAULT 0,
      profit NUMERIC(18,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_users_token
    ON users(token)
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_products_shop
    ON products(shop_id)
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_shop
    ON transactions(shop_id)
  `);

  return true;
}

async function getUser(req) {
  const token = getToken(req);

  if (!token) return null;

  const p = await db();

  const result = await p.query(`
    SELECT
      u.id,
      u.shop_id,
      u.name,
      u.username,
      u.role,
      s.name AS shop_name,
      s.address AS shop_address,
      s.phone AS shop_phone
    FROM users u
    JOIN shops s ON s.id = u.shop_id
    WHERE u.token = $1
    LIMIT 1
  `, [token]);

  return result.rows[0] || null;
}

function body(req) {
  return req.body || {};
}

module.exports = async function handler(req, res) {

  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {

    const url = new URL(
      req.url,
      `https://${req.headers.host || "localhost"}`
    );

    const path = url.pathname.replace(/^\/api/, "") || "/";

    // -----------------------------
    // API HEALTH
    // -----------------------------

    if (path === "/" && req.method === "GET") {
      return send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: Boolean(process.env.DATABASE_URL)
      });
    }

    // -----------------------------
    // SETUP
    // -----------------------------

    if (path === "/setup" && (req.method === "GET" || req.method === "POST")) {

      await setupDatabase();

      return send(res, 200, {
        success: true,
        message: "Database is ready."
      });
    }

    await setupDatabase();

    // -----------------------------
    // REGISTER
    // -----------------------------

    if (path === "/register" && req.method === "POST") {

      const b = body(req);

      const shopName = String(
        b.shop_name || b.shopName || ""
      ).trim();

      const name = String(
        b.name || ""
      ).trim();

      const username = String(
        b.username || ""
      ).trim().toLowerCase();

      const password = String(
        b.password || ""
      );

      if (!shopName || !name || !username || !password) {
        return send(res, 400, {
          success: false,
          error: "تمام معلومات را وارد کنید."
        });
      }

      if (password.length < 4) {
        return send(res, 400, {
          success: false,
          error: "رمز عبور حداقل 4 حرف باشد."
        });
      }

      const p = await db();

      const existing = await p.query(
        `SELECT id FROM users WHERE username=$1 LIMIT 1`,
        [username]
      );

      if (existing.rows.length) {
        return send(res, 409, {
          success: false,
          error: "این نام کاربری قبلاً استفاده شده است."
        });
      }

      const shop = await p.query(`
        INSERT INTO shops(name)
        VALUES($1)
        RETURNING *
      `, [shopName]);

      const shopId = shop.rows[0].id;

      const token = makeToken();

      const user = await p.query(`
        INSERT INTO users(
          shop_id,
          name,
          username,
          password_hash,
          role,
          token
        )
        VALUES($1,$2,$3,$4,'owner',$5)
        RETURNING
          id,
          shop_id,
          name,
          username,
          role
      `, [
        shopId,
        name,
        username,
        hashPassword(password),
        token
      ]);

      return send(res, 201, {
        success: true,
        token,
        user: {
          ...user.rows[0],
          shop_name: shopName
        }
      });
    }

    // -----------------------------
    // LOGIN
    // -----------------------------

    if (path === "/login" && req.method === "POST") {

      const b = body(req);

      const username = String(
        b.username || ""
      ).trim().toLowerCase();

      const password = String(
        b.password || ""
      );

      if (!username || !password) {
        return send(res, 400, {
          success: false,
          error: "نام کاربری و رمز عبور را وارد کنید."
        });
      }

      const p = await db();

      const result = await p.query(`
        SELECT
          u.id,
          u.shop_id,
          u.name,
          u.username,
          u.role,
          u.password_hash,
          s.name AS shop_name
        FROM users u
        JOIN shops s ON s.id=u.shop_id
        WHERE u.username=$1
        LIMIT 1
      `, [username]);

      if (!result.rows.length) {
        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
      }

      const user = result.rows[0];

      if (user.password_hash !== hashPassword(password)) {
        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
      }

      const token = makeToken();

      await p.query(
        `UPDATE users SET token=$1 WHERE id=$2`,
        [token, user.id]
      );

      delete user.password_hash;

      return send(res, 200, {
        success: true,
        token,
        user
      });
    }

    // -----------------------------
    // AUTH
    // -----------------------------

    const user = await getUser(req);

    if (!user) {
      return send(res, 401, {
        success: false,
        error: "لطفاً وارد حساب شوید."
      });
    }

    const shopId = user.shop_id;

    // -----------------------------
    // ME
    // -----------------------------

    if (path === "/me" && req.method === "GET") {

      return send(res, 200, {
        success: true,
        user
      });
    }

    // -----------------------------
    // LOGOUT
    // -----------------------------

    if (path === "/logout" && req.method === "POST") {

      const p = await db();

      await p.query(
        `UPDATE users SET token=NULL WHERE id=$1`,
        [user.id]
      );

      return send(res, 200, {
        success: true,
        message: "خروج موفقانه انجام شد."
      });
    }

    // -----------------------------
    // SHOP GET
    // -----------------------------

    if (path === "/shop" && req.method === "GET") {

      const p = await db();

      const result = await p.query(`
        SELECT *
        FROM shops
        WHERE id=$1
        LIMIT 1
      `, [shopId]);

      return send(res, 200, {
        success: true,
        shop: result.rows[0] || null
      });
    }

    // -----------------------------
    // SHOP UPDATE
    // -----------------------------

    if (path === "/shop" && req.method === "PUT") {

      if (user.role !== "owner") {
        return send(res, 403, {
          success: false,
          error: "فقط مالک می‌تواند تنظیمات دوکان را تغییر دهد."
        });
      }

      const b = body(req);

      const name = String(
        b.name || b.shop_name || ""
      ).trim();

      const address = String(
        b.address || ""
      ).trim();

      const phone = String(
        b.phone || ""
      ).trim();

      if (!name) {
        return send(res, 400, {
          success: false,
          error: "نام دوکان ضروری است."
        });
      }

      const p = await db();

      const result = await p.query(`
        UPDATE shops
        SET
          name=$1,
          address=$2,
          phone=$3
        WHERE id=$4
        RETURNING *
      `, [
        name,
        address,
        phone,
        shopId
      ]);

      return send(res, 200, {
        success: true,
        shop: result.rows[0]
      });
    }

    // -----------------------------
    // PRODUCTS GET
    // -----------------------------

    if (path === "/products" && req.method === "GET") {

      const p = await db();

      const result = await p.query(`
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
        WHERE shop_id=$1
        ORDER BY id DESC
      `, [shopId]);

      return send(res, 200, {
        success: true,
        products: result.rows
      });
    }

    // -----------------------------
    // PRODUCT CREATE
    // -----------------------------

    if (path === "/products" && req.method === "POST") {

      const b = body(req);

      const name = String(b.name || "").trim();
      const brand = String(b.brand || "").trim();
      const model = String(b.model || "").trim();

      const buyPrice = Number(b.buy_price || 0);
      const sellPrice = Number(b.sell_price || 0);
      const quantity = Number(
        b.quantity ?? b.stock ?? 0
      );

      if (!name) {
        return send(res, 400, {
          success: false,
          error: "نام جنس ضروری است."
        });
      }

      if (
        !Number.isFinite(buyPrice) ||
        !Number.isFinite(sellPrice) ||
        !Number.isFinite(quantity) ||
        buyPrice < 0 ||
        sellPrice < 0 ||
        quantity < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "قیمت یا تعداد نادرست است."
        });
      }

      const p = await db();

      const result = await p.query(`
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
        shopId,
        name,
        brand,
        model,
        buyPrice,
        sellPrice,
        quantity
      ]);

      return send(res, 201, {
        success: true,
        product: result.rows[0]
      });
    }

    // -----------------------------
    // PRODUCT UPDATE
    // -----------------------------

    if (
      path.startsWith("/products/") &&
      req.method === "PUT"
    ) {

      const id = Number(
        path.split("/")[2]
      );

      if (!id) {
        return send(res, 400, {
          success: false,
          error: "شناسه جنس نادرست است."
        });
      }

      const b = body(req);

      const name = String(b.name || "").trim();
      const brand = String(b.brand || "").trim();
      const model = String(b.model || "").trim();

      const buyPrice = Number(b.buy_price || 0);
      const sellPrice = Number(b.sell_price || 0);
      const quantity = Number(
        b.quantity ?? b.stock ?? 0
      );

      const p = await db();

      const result = await p.query(`
        UPDATE products
        SET
          name=$1,
          brand=$2,
          model=$3,
          buy_price=$4,
          sell_price=$5,
          quantity=$6,
          updated_at=NOW()
        WHERE id=$7
        AND shop_id=$8
        RETURNING *
      `, [
        name,
        brand,
        model,
        buyPrice,
        sellPrice,
        quantity,
        id,
        shopId
      ]);

      if (!result.rows.length) {
        return send(res, 404, {
          success: false,
          error: "جنس پیدا نشد."
        });
      }

      return send(res, 200, {
        success: true,
        product: result.rows[0]
      });
    }

    // -----------------------------
    // PRODUCT DELETE
    // -----------------------------

    if (
      path.startsWith("/products/") &&
      req.method === "DELETE"
    ) {

      const id = Number(
        path.split("/")[2]
      );

      const p = await db();

      const result = await p.query(`
        DELETE FROM products
        WHERE id=$1
        AND shop_id=$2
        RETURNING id
      `, [
        id,
        shopId
      ]);

      if (!result.rows.length) {
        return send(res, 404, {
          success: false,
          error: "جنس پیدا نشد."
        });
      }

      return send(res, 200, {
        success: true,
        message: "جنس حذف شد."
      });
    }

    // -----------------------------
    // BUY
    // -----------------------------

    if (path === "/buy" && req.method === "POST") {

      const b = body(req);

      const productId = Number(b.product_id);
      const quantity = Number(b.quantity);
      const unitPrice = Number(b.unit_price);

      if (
        !productId ||
        quantity <= 0 ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "معلومات خرید نادرست است."
        });
      }

      const p = await db();

      const productResult = await p.query(`
        SELECT *
        FROM products
        WHERE id=$1
        AND shop_id=$2
        FOR UPDATE
      `, [
        productId,
        shopId
      ]);

      if (!productResult.rows.length) {
        return send(res, 404, {
          success: false,
          error: "جنس پیدا نشد."
        });
      }

      const product = productResult.rows[0];

      const oldStock = Number(product.quantity || 0);
      const oldBuy = Number(product.buy_price || 0);

      // میانگین وزنی قیمت خرید
      const newAverage =
        (
          oldStock * oldBuy +
          quantity * unitPrice
        ) /
        (oldStock + quantity);

      const newStock =
        oldStock + quantity;

      await p.query(`
        UPDATE products
        SET
          quantity=$1,
          buy_price=$2,
          updated_at=NOW()
        WHERE id=$3
        AND shop_id=$4
      `, [
        newStock,
        newAverage,
        productId,
        shopId
      ]);

      const total =
        quantity * unitPrice;

      await p.query(`
        INSERT INTO transactions(
          shop_id,
          product_id,
          type,
          quantity,
          unit_price,
          total,
          buy_cost,
          profit
        )
        VALUES(
          $1,$2,'buy',$3,$4,$5,$6,0
        )
      `, [
        shopId,
        productId,
        quantity,
        unitPrice,
        total,
        total
      ]);

      return send(res, 200, {
        success: true,
        message: "خرید ثبت شد.",
        stock: newStock,
        average_buy_price: newAverage
      });
    }

    // -----------------------------
    // SELL
    // -----------------------------

    if (path === "/sell" && req.method === "POST") {

      const b = body(req);

      const productId = Number(b.product_id);
      const quantity = Number(b.quantity);
      const unitPrice = Number(b.unit_price);

      if (
        !productId ||
        quantity <= 0 ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "معلومات فروش نادرست است."
        });
      }

      const p = await db();

      const productResult = await p.query(`
        SELECT *
        FROM products
        WHERE id=$1
        AND shop_id=$2
        FOR UPDATE
      `, [
        productId,
        shopId
      ]);

      if (!productResult.rows.length) {
        return send(res, 404, {
          success: false,
          error: "جنس پیدا نشد."
        });
      }

      const product = productResult.rows[0];

      const stock =
        Number(product.quantity || 0);

      const averageBuy =
        Number(product.buy_price || 0);

      if (quantity > stock) {
        return send(res, 400, {
          success: false,
          error:
            `موجودی کافی نیست. موجودی فعلی: ${stock}`
        });
      }

      const newStock =
        stock - quantity;

      const total =
        quantity * unitPrice;

      const cost =
        quantity * averageBuy;

      const profit =
        total - cost;

      await p.query(`
        UPDATE products
        SET
          quantity=$1,
          updated_at=NOW()
        WHERE id=$2
        AND shop_id=$3
      `, [
        newStock,
        productId,
        shopId
      ]);

      await p.query(`
        INSERT INTO transactions(
          shop_id,
          product_id,
          type,
          quantity,
          unit_price,
          total,
          buy_cost,
          profit
        )
        VALUES(
          $1,$2,'sell',$3,$4,$5,$6,$7
        )
      `, [
        shopId,
        productId,
        quantity,
        unitPrice,
        total,
        cost,
        profit
      ]);

      return send(res, 200, {
        success: true,
        message: "فروش ثبت شد.",
        stock: newStock,
        profit
      });
    }

    // -----------------------------
    // TRANSACTIONS
    // -----------------------------

    if (path === "/transactions" && req.method === "GET") {

      const p = await db();

      const result = await p.query(`
        SELECT
          t.*,
          p.name AS product_name,
          p.brand,
          p.model
        FROM transactions t
        LEFT JOIN products p
          ON p.id=t.product_id
        WHERE t.shop_id=$1
        ORDER BY t.id DESC
        LIMIT 500
      `, [shopId]);

      return send(res, 200, {
        success: true,
        transactions: result.rows
      });
    }

    // -----------------------------
    // WORKERS GET
    // -----------------------------

    if (path === "/workers" && req.method === "GET") {

      if (user.role !== "owner") {
        return send(res, 403, {
          success: false,
          error: "فقط مالک دسترسی دارد."
        });
      }

      const p = await db();

      const result = await p.query(`
        SELECT
          id,
          name,
          username,
          role,
          created_at
        FROM users
        WHERE shop_id=$1
        ORDER BY id DESC
      `, [shopId]);

      return send(res, 200, {
        success: true,
        workers: result.rows
      });
    }

    // -----------------------------
    // WORKER CREATE
    // -----------------------------

    if (path === "/workers" && req.method === "POST") {

      if (user.role !== "owner") {
        return send(res, 403, {
          success: false,
          error: "فقط مالک می‌تواند کارمند اضافه کند."
        });
      }

      const b = body(req);

      const name =
        String(b.name || "").trim();

      const username =
        String(b.username || "")
          .trim()
          .toLowerCase();

      const password =
        String(b.password || "");

      if (!name || !username || !password) {
        return send(res, 400, {
          success: false,
          error: "تمام معلومات کارمند را وارد کنید."
        });
      }

      const p = await db();

      const existing = await p.query(
        `SELECT id FROM users WHERE username=$1`,
        [username]
      );

      if (existing.rows.length) {
        return send(res, 409, {
          success: false,
          error: "این نام کاربری قبلاً وجود دارد."
        });
      }

      const result = await p.query(`
        INSERT INTO users(
          shop_id,
          name,
          username,
          password_hash,
          role
        )
        VALUES($1,$2,$3,$4,'worker')
        RETURNING
          id,
          name,
          username,
          role
      `, [
        shopId,
        name,
        username,
        hashPassword(password)
      ]);

      return send(res, 201, {
        success: true,
        worker: result.rows[0]
      });
    }

    // -----------------------------
    // WORKER DELETE
    // -----------------------------

    if (
      path.startsWith("/workers/") &&
      req.method === "DELETE"
    ) {

      if (user.role !== "owner") {
        return send(res, 403, {
          success: false,
          error: "فقط مالک می‌تواند کارمند حذف کند."
        });
      }

      const id =
        Number(path.split("/")[2]);

      if (id === user.id) {
        return send(res, 400, {
          success: false,
          error: "نمی‌توانید حساب خودتان را حذف کنید."
        });
      }

      const p = await db();

      const result = await p.query(`
        DELETE FROM users
        WHERE id=$1
        AND shop_id=$2
        AND role='worker'
        RETURNING id
      `, [
        id,
        shopId
      ]);

      if (!result.rows.length) {
        return send(res, 404, {
          success: false,
          error: "کارمند پیدا نشد."
        });
      }

      return send(res, 200, {
        success: true,
        message: "کارمند حذف شد."
      });
    }

    // -----------------------------
    // DASHBOARD
    // -----------------------------

    if (path === "/dashboard" && req.method === "GET") {

      const p = await db();

      const productsResult = await p.query(`
        SELECT
          COUNT(*)::int AS products_count,
          COALESCE(SUM(quantity),0) AS total_stock
        FROM products
        WHERE shop_id=$1
      `, [shopId]);

      const salesResult = await p.query(`
        SELECT
          COALESCE(SUM(total),0) AS total_sales,
          COALESCE(SUM(profit),0) AS total_profit
        FROM transactions
        WHERE shop_id=$1
        AND type='sell'
      `, [shopId]);

      const purchasesResult = await p.query(`
        SELECT
          COALESCE(SUM(total),0) AS total_purchases
        FROM transactions
        WHERE shop_id=$1
        AND type='buy'
      `, [shopId]);

      const a = productsResult.rows[0];
      const s = salesResult.rows[0];
      const b = purchasesResult.rows[0];

      return send(res, 200, {
        success: true,
        dashboard: {
          products_count: Number(a.products_count || 0),
          total_stock: Number(a.total_stock || 0),
          total_sales: Number(s.total_sales || 0),
          total_profit: Number(s.total_profit || 0),
          total_purchases: Number(b.total_purchases || 0)
        }
      });
    }

    // -----------------------------
    // UNKNOWN
    // -----------------------------

    return send(res, 404, {
      success: false,
      error: "Endpoint not found",
      path
    });

  } catch (error) {

    console.error("API ERROR:", error);

    return send(res, 500, {
      success: false,
      error: error.message || "خطای سرور"
    });

  }
};