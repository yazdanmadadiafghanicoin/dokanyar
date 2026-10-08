const { Pool } = require("pg");
const crypto = require("crypto");

let pool;

function db() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL در Vercel تنظیم نشده است.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5
    });
  }

  return pool;
}

function send(res, status, data) {
  return res.status(status).json(data);
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clean(v) {
  return String(v ?? "").trim();
}

async function setup() {
  const d = db();

  await d.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await d.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner'
        CHECK (role IN ('owner','worker')),
      token TEXT UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, username)
    );
  `);

  await d.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
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

  await d.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
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

  await d.query(`
    CREATE INDEX IF NOT EXISTS products_shop_idx
    ON products(shop_id);
  `);

  await d.query(`
    CREATE INDEX IF NOT EXISTS transactions_shop_idx
    ON transactions(shop_id);
  `);

  return true;
}

async function auth(req) {
  const token =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.headers["x-auth-token"];

  if (!token) return null;

  const result = await db().query(`
    SELECT
      u.id,
      u.shop_id,
      u.name,
      u.username,
      u.role,
      u.active,
      s.name AS shop_name,
      s.phone AS shop_phone,
      s.address AS shop_address
    FROM users u
    INNER JOIN shops s ON s.id = u.shop_id
    WHERE u.token = $1
      AND u.active = TRUE
  `, [token]);

  return result.rows[0] || null;
}

module.exports = async function handler(req, res) {
  try {
    const method = req.method || "GET";

    const url = new URL(
      req.url,
      `https://${req.headers.host || "localhost"}`
    );

    const path =
      url.pathname.replace(/^\/api/, "") || "/";

    await setup();

    const d = db();

    // -------------------------
    // API HOME
    // -------------------------
    if (path === "/" && method === "GET") {
      return send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: Boolean(process.env.DATABASE_URL)
      });
    }

    // -------------------------
    // SETUP
    // -------------------------
    if (
      path === "/setup" &&
      (method === "GET" || method === "POST")
    ) {
      return send(res, 200, {
        success: true,
        message: "دیتابیس دوکان‌یار آماده است."
      });
    }

    // -------------------------
    // REGISTER SHOP
    // -------------------------
    if (path === "/register" && method === "POST") {
      const body = req.body || {};

      const shopName = clean(body.shop_name);
      const ownerName = clean(body.name);
      const username = clean(body.username).toLowerCase();
      const password = clean(body.password);
      const phone = clean(body.phone);
      const address = clean(body.address);

      if (!shopName)
        return send(res, 400, {
          success: false,
          error: "نام دوکان را وارد کنید."
        });

      if (!ownerName)
        return send(res, 400, {
          success: false,
          error: "نام صاحب دوکان را وارد کنید."
        });

      if (username.length < 3)
        return send(res, 400, {
          success: false,
          error: "نام کاربری حداقل ۳ حرف باشد."
        });

      if (password.length < 4)
        return send(res, 400, {
          success: false,
          error: "رمز عبور حداقل ۴ حرف باشد."
        });

      const client = await d.connect();

      try {
        await client.query("BEGIN");

        const existing = await client.query(
          `SELECT id FROM users WHERE username=$1`,
          [username]
        );

        if (existing.rows.length) {
          await client.query("ROLLBACK");

          return send(res, 409, {
            success: false,
            error: "این نام کاربری قبلاً استفاده شده است."
          });
        }

        const shop = await client.query(`
          INSERT INTO shops
          (name,phone,address)
          VALUES ($1,$2,$3)
          RETURNING id,name,phone,address
        `, [
          shopName,
          phone,
          address
        ]);

        const token = makeToken();

        const user = await client.query(`
          INSERT INTO users
          (shop_id,name,username,password_hash,role,token)
          VALUES ($1,$2,$3,$4,'owner',$5)
          RETURNING id,name,username,role
        `, [
          shop.rows[0].id,
          ownerName,
          username,
          hashPassword(password),
          token
        ]);

        await client.query("COMMIT");

        return send(res, 201, {
          success: true,
          message: "دوکان با موفقیت ثبت شد.",
          token,
          user: user.rows[0],
          shop: shop.rows[0]
        });

      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // -------------------------
    // LOGIN
    // -------------------------
    if (path === "/login" && method === "POST") {
      const body = req.body || {};

      const username = clean(body.username).toLowerCase();
      const password = clean(body.password);

      if (!username || !password) {
        return send(res, 400, {
          success: false,
          error: "نام کاربری و رمز عبور را وارد کنید."
        });
      }

      const result = await d.query(`
        SELECT
          u.id,
          u.shop_id,
          u.name,
          u.username,
          u.password_hash,
          u.role,
          s.name AS shop_name,
          s.phone AS shop_phone,
          s.address AS shop_address
        FROM users u
        INNER JOIN shops s ON s.id=u.shop_id
        WHERE u.username=$1
          AND u.active=TRUE
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

      await d.query(
        `UPDATE users SET token=$1 WHERE id=$2`,
        [token, user.id]
      );

      return send(res, 200, {
        success: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role
        },
        shop: {
          id: user.shop_id,
          name: user.shop_name,
          phone: user.shop_phone,
          address: user.shop_address
        }
      });
    }

    // -------------------------
    // LOGOUT
    // -------------------------
    if (path === "/logout" && method === "POST") {
      const user = await auth(req);

      if (user) {
        await d.query(
          `UPDATE users SET token=NULL WHERE id=$1`,
          [user.id]
        );
      }

      return send(res, 200, {
        success: true
      });
    }

    // -------------------------
    // ME
    // -------------------------
    if (path === "/me" && method === "GET") {
      const user = await auth(req);

      if (!user) {
        return send(res, 401, {
          success: false,
          error: "ورود معتبر نیست."
        });
      }

      return send(res, 200, {
        success: true,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role
        },
        shop: {
          id: user.shop_id,
          name: user.shop_name,
          phone: user.shop_phone,
          address: user.shop_address
        }
      });
    }

    // -------------------------
    // SHOP
    // -------------------------
    if (path === "/shop") {
      const user = await auth(req);

      if (!user) {
        return send(res, 401, {
          success: false,
          error: "ابتدا وارد شوید."
        });
      }

      if (method === "GET") {
        const r = await d.query(
          `SELECT id,name,phone,address FROM shops WHERE id=$1`,
          [user.shop_id]
        );

        return send(res, 200, {
          success: true,
          shop: r.rows[0]
        });
      }

      if (method === "PUT") {
        if (user.role !== "owner") {
          return send(res, 403, {
            success: false,
            error: "فقط صاحب دوکان اجازه دارد."
          });
        }

        const body = req.body || {};

        const name = clean(body.name);
        const phone = clean(body.phone);
        const address = clean(body.address);

        if (!name) {
          return send(res, 400, {
            success: false,
            error: "نام دوکان الزامی است."
          });
        }

        const r = await d.query(`
          UPDATE shops
          SET name=$1,phone=$2,address=$3
          WHERE id=$4
          RETURNING *
        `, [
          name,
          phone,
          address,
          user.shop_id
        ]);

        return send(res, 200, {
          success: true,
          shop: r.rows[0]
        });
      }
    }

    // -------------------------
    // PRODUCTS
    // -------------------------
    if (path === "/products") {
      const user = await auth(req);

      if (!user) {
        return send(res, 401, {
          success: false,
          error: "ابتدا وارد شوید."
        });
      }

      if (method === "GET") {
        const r = await d.query(`
          SELECT
            id,name,brand,model,
            buy_price,sell_price,stock,
            created_at,updated_at
          FROM products
          WHERE shop_id=$1
          ORDER BY id DESC
        `, [user.shop_id]);

        return send(res, 200, {
          success: true,
          products: r.rows
        });
      }

      if (method === "POST") {
        const body = req.body || {};

        const name = clean(body.name);
        const brand = clean(body.brand);
        const model = clean(body.model);

        const buyPrice = num(body.buy_price);
        const sellPrice = num(body.sell_price);
        const stock = num(body.stock ?? 0);

        if (!name)
          return send(res, 400, {
            success: false,
            error: "نام کالا الزامی است."
          });

        if (
          buyPrice === null ||
          buyPrice < 0
        )
          return send(res, 400, {
            success: false,
            error: "قیمت خرید نامعتبر است."
          });

        if (
          sellPrice === null ||
          sellPrice < 0
        )
          return send(res, 400, {
            success: false,
            error: "قیمت فروش نامعتبر است."
          });

        if (
          stock === null ||
          !Number.isInteger(stock) ||
          stock < 0
        )
          return send(res, 400, {
            success: false,
            error: "موجودی نامعتبر است."
          });

        const r = await d.query(`
          INSERT INTO products
          (shop_id,name,brand,model,buy_price,sell_price,stock)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
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
          product: r.rows[0]
        });
      }

      const match = path.match(/^\/products\/(\d+)$/);

      if (match) {
        const id = Number(match[1]);

        if (method === "PUT") {
          const body = req.body || {};

          const name = clean(body.name);
          const brand = clean(body.brand);
          const model = clean(body.model);
          const buyPrice = num(body.buy_price);
          const sellPrice = num(body.sell_price);
          const stock = num(body.stock);

          if (!name)
            return send(res,400,{
              success:false,
              error:"نام کالا الزامی است."
            });

          const r = await d.query(`
            UPDATE products
            SET
              name=$1,
              brand=$2,
              model=$3,
              buy_price=$4,
              sell_price=$5,
              stock=$6,
              updated_at=NOW()
            WHERE id=$7
              AND shop_id=$8
            RETURNING *
          `, [
            name,
            brand,
            model,
            buyPrice ?? 0,
            sellPrice ?? 0,
            Number.isInteger(stock) ? stock : 0,
            id,
            user.shop_id
          ]);

          if (!r.rows.length)
            return send(res,404,{
              success:false,
              error:"کالا پیدا نشد."
            });

          return send(res,200,{
            success:true,
            product:r.rows[0]
          });
        }

        if (method === "DELETE") {
          const used = await d.query(`
            SELECT id
            FROM transactions
            WHERE product_id=$1
            LIMIT 1
          `,[id]);

          if (used.rows.length) {
            return send(res,400,{
              success:false,
              error:"این کالا سابقه معامله دارد و قابل حذف نیست."
            });
          }

          const r = await d.query(`
            DELETE FROM products
            WHERE id=$1 AND shop_id=$2
            RETURNING id
          `,[id,user.shop_id]);

          if (!r.rows.length)
            return send(res,404,{
              success:false,
              error:"کالا پیدا نشد."
            });

          return send(res,200,{
            success:true
          });
        }
      }
    }

    // -------------------------
    // BUY
    // -------------------------
    if (path === "/buy" && method === "POST") {
      const user = await auth(req);

      if (!user) {
        return send(res,401,{
          success:false,
          error:"ابتدا وارد شوید."
        });
      }

      const body = req.body || {};

      const productId = num(body.product_id);
      const quantity = num(body.quantity);
      const unitPrice = num(body.unit_price);

      if (
        !Number.isInteger(productId) ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        unitPrice === null ||
        unitPrice < 0
      ) {
        return send(res,400,{
          success:false,
          error:"اطلاعات خرید نامعتبر است."
        });
      }

      const client = await d.connect();

      try {
        await client.query("BEGIN");

        const p = await client.query(`
          SELECT *
          FROM products
          WHERE id=$1 AND shop_id=$2
          FOR UPDATE
        `,[
          productId,
          user.shop_id
        ]);

        if (!p.rows.length) {
          await client.query("ROLLBACK");

          return send(res,404,{
            success:false,
            error:"کالا پیدا نشد."
          });
        }

        const product = p.rows[0];

        const oldStock = Number(product.stock || 0);
        const oldBuy = Number(product.buy_price || 0);

        const newStock = oldStock + quantity;

        // میانگین وزنی قیمت خرید
        const averageBuy =
          newStock === 0
            ? unitPrice
            : (
                (oldStock * oldBuy) +
                (quantity * unitPrice)
              ) / newStock;

        const total = quantity * unitPrice;

        await client.query(`
          UPDATE products
          SET
            stock=$1,
            buy_price=$2,
            updated_at=NOW()
          WHERE id=$3
        `,[
          newStock,
          averageBuy,
          productId
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
        `,[
          user.shop_id,
          productId,
          user.id,
          quantity,
          unitPrice,
          unitPrice,
          total
        ]);

        await client.query("COMMIT");

        return send(res,200,{
          success:true,
          message:"خرید ثبت شد.",
          total,
          average_buy_price:averageBuy
        });

      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // -------------------------
    // SELL
    // -------------------------
    if (path === "/sell" && method === "POST") {
      const user = await auth(req);

      if (!user) {
        return send(res,401,{
          success:false,
          error:"ابتدا وارد شوید."
        });
      }

      const body = req.body || {};

      const productId = num(body.product_id);
      const quantity = num(body.quantity);
      const unitPrice = num(body.unit_price);

      if (
        !Number.isInteger(productId) ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        unitPrice === null ||
        unitPrice < 0
      ) {
        return send(res,400,{
          success:false,
          error:"اطلاعات فروش نامعتبر است."
        });
      }

      const client = await d.connect();

      try {
        await client.query("BEGIN");

        const p = await client.query(`
          SELECT *
          FROM products
          WHERE id=$1 AND shop_id=$2
          FOR UPDATE
        `,[
          productId,
          user.shop_id
        ]);

        if (!p.rows.length) {
          await client.query("ROLLBACK");

          return send(res,404,{
            success:false,
            error:"کالا پیدا نشد."
          });
        }

        const product = p.rows[0];

        const stock = Number(product.stock || 0);

        if (stock < quantity) {
          await client.query("ROLLBACK");

          return send(res,400,{
            success:false,
            error:
              `موجودی کافی نیست. موجودی فعلی: ${stock}`
          });
        }

        const buyPrice =
          Number(product.buy_price || 0);

        const total =
          quantity * unitPrice;

        const profit =
          (unitPrice - buyPrice) * quantity;

        await client.query(`
          UPDATE products
          SET
            stock=stock-$1,
            updated_at=NOW()
          WHERE id=$2
        `,[
          quantity,
          productId
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
        `,[
          user.shop_id,
          productId,
          user.id,
          quantity,
          unitPrice,
          buyPrice,
          total,
          profit
        ]);

        await client.query("COMMIT");

        return send(res,200,{
          success:true,
          message:"فروش ثبت شد.",
          total,
          profit
        });

      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // -------------------------
    // TRANSACTIONS
    // -------------------------
    if (
      path === "/transactions" &&
      method === "GET"
    ) {
      const user = await auth(req);

      if (!user) {
        return send(res,401,{
          success:false,
          error:"ابتدا وارد شوید."
        });
      }

      const r = await d.query(`
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
          u.name AS username
        FROM transactions t
        INNER JOIN products p
          ON p.id=t.product_id
        LEFT JOIN users u
          ON u.id=t.user_id
        WHERE t.shop_id=$1
        ORDER BY t.id DESC
        LIMIT 500
      `,[
        user.shop_id
      ]);

      return send(res,200,{
        success:true,
        transactions:r.rows
      });
    }

    // -------------------------
    // WORKERS
    // -------------------------
    if (path === "/workers") {
      const user = await auth(req);

      if (!user) {
        return send(res,401,{
          success:false,
          error:"ابتدا وارد شوید."
        });
      }

      if (user.role !== "owner") {
        return send(res,403,{
          success:false,
          error:"فقط صاحب دوکان اجازه دارد."
        });
      }

      if (method === "GET") {
        const r = await d.query(`
          SELECT
            id,name,username,active,created_at
          FROM users
          WHERE shop_id=$1
            AND role='worker'
          ORDER BY id DESC
        `,[
          user.shop_id
        ]);

        return send(res,200,{
          success:true,
          workers:r.rows
        });
      }

      if (method === "POST") {
        const body = req.body || {};

        const name = clean(body.name);
        const username =
          clean(body.username).toLowerCase();
        const password = clean(body.password);

        if (!name || username.length < 3) {
          return send(res,400,{
            success:false,
            error:"نام و نام کاربری معتبر وارد کنید."
          });
        }

        if (password.length < 4) {
          return send(res,400,{
            success:false,
            error:"رمز کارمند حداقل ۴ حرف باشد."
          });
        }

        const exists = await d.query(`
          SELECT id FROM users
          WHERE username=$1
        `,[username]);

        if (exists.rows.length) {
          return send(res,409,{
            success:false,
            error:"این نام کاربری قبلاً استفاده شده است."
          });
        }

        const r = await d.query(`
          INSERT INTO users
          (
            shop_id,
            name,
            username,
            password_hash,
            role
          )
          VALUES
          ($1,$2,$3,$4,'worker')
          RETURNING id,name,username,role,active
        `,[
          user.shop_id,
          name,
          username,
          hashPassword(password)
        ]);

        return send(res,201,{
          success:true,
          worker:r.rows[0]
        });
      }
    }

    const workerMatch =
      path.match(/^\/workers\/(\d+)$/);

    if (
      workerMatch &&
      method === "DELETE"
    ) {
      const user = await auth(req);

      if (!user || user.role !== "owner") {
        return send(res,403,{
          success:false,
          error:"اجازه ندارید."
        });
      }

      const id = Number(workerMatch[1]);

      await d.query(`
        DELETE FROM users
        WHERE id=$1
          AND shop_id=$2
          AND role='worker'
      `,[
        id,
        user.shop_id
      ]);

      return send(res,200,{
        success:true
      });
    }

    // -------------------------
    // DASHBOARD
    // -------------------------
    if (
      path === "/dashboard" &&
      method === "GET"
    ) {
      const user = await auth(req);

      if (!user) {
        return send(res,401,{
          success:false,
          error:"ابتدا وارد شوید."
        });
      }

      const products = await d.query(`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(stock),0)::int AS stock
        FROM products
        WHERE shop_id=$1
      `,[
        user.shop_id
      ]);

      const sales = await d.query(`
        SELECT
          COALESCE(SUM(total),0) AS total,
          COALESCE(SUM(profit),0) AS profit,
          COUNT(*)::int AS count
        FROM transactions
        WHERE shop_id=$1
          AND type='sell'
      `,[
        user.shop_id
      ]);

      const purchases = await d.query(`
        SELECT
          COALESCE(SUM(total),0) AS total,
          COUNT(*)::int AS count
        FROM transactions
        WHERE shop_id=$1
          AND type='buy'
      `,[
        user.shop_id
      ]);

      const low = await d.query(`
        SELECT COUNT(*)::int AS count
        FROM products
        WHERE shop_id=$1
          AND stock <= 3
      `,[
        user.shop_id
      ]);

      return send(res,200,{
        success:true,
        dashboard:{
          products:Number(products.rows[0].count),
          stock:Number(products.rows[0].stock),
          sales:Number(sales.rows[0].total),
          profit:Number(sales.rows[0].profit),
          sale_count:Number(sales.rows[0].count),
          purchases:Number(purchases.rows[0].total),
          purchase_count:Number(purchases.rows[0].count),
          low_stock:Number(low.rows[0].count)
        }
      });
    }

    return send(res,404,{
      success:false,
      error:"Endpoint not found."
    });

  } catch(error) {
    console.error("DOKANYAAR API ERROR:",error);

    return send(res,500,{
      success:false,
      error:error.message ||
        "خطای داخلی سرور"
    });
  }
};