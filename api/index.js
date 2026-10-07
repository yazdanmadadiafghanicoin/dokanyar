const { Pool } = require("pg");

let pool;

function getPool() {

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL در تنظیمات Vercel ثبت نشده است.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      max: 5
    });
  }

  return pool;
}

function send(res, status, data) {

  res.status(status).json(data);

}

function number(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n;
}

async function setup() {

  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
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
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      type TEXT NOT NULL CHECK (type IN ('buy','sell')),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
      buy_price NUMERIC(18,2) NOT NULL DEFAULT 0,
      total NUMERIC(18,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS products_name_idx
    ON products(name);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS transactions_created_at_idx
    ON transactions(created_at);
  `);

  return true;
}

module.exports = async function handler(req, res) {

  try {

    const method = req.method || "GET";

    const url = new URL(
      req.url,
      `https://${req.headers.host || "localhost"}`
    );

    const path = url.pathname.replace(/^\/api/, "") || "/";

    /*
      Health
    */

    if (path === "/" && method === "GET") {

      return send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database: Boolean(process.env.DATABASE_URL)
      });

    }

    /*
      Setup database
    */

    if (path === "/setup" && (method === "GET" || method === "POST")) {

      await setup();

      return send(res, 200, {
        success: true,
        message: "جداول دوکان‌یار آماده شد."
      });

    }

    /*
      Always make sure tables exist.
    */

    await setup();

    const db = getPool();

    /*
      GET PRODUCTS
    */

    if (path === "/products" && method === "GET") {

      const result = await db.query(`
        SELECT
          id,
          name,
          brand,
          model,
          buy_price,
          sell_price,
          stock,
          created_at,
          updated_at
        FROM products
        ORDER BY id DESC
      `);

      return send(res, 200, {
        success: true,
        products: result.rows
      });

    }

    /*
      CREATE PRODUCT
    */

    if (path === "/products" && method === "POST") {

      const body = req.body || {};

      const name = String(body.name || "").trim();
      const brand = String(body.brand || "").trim();
      const model = String(body.model || "").trim();

      const buyPrice = number(body.buy_price);
      const sellPrice = number(body.sell_price);
      const stock = number(body.stock ?? 0);

      if (!name) {
        return send(res, 400, {
          success: false,
          error: "نام کالا الزامی است."
        });
      }

      if (buyPrice === null || buyPrice < 0) {
        return send(res, 400, {
          success: false,
          error: "قیمت خرید نامعتبر است."
        });
      }

      if (sellPrice === null || sellPrice < 0) {
        return send(res, 400, {
          success: false,
          error: "قیمت فروش نامعتبر است."
        });
      }

      if (
        stock === null ||
        !Number.isInteger(stock) ||
        stock < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "تعداد موجودی نامعتبر است."
        });
      }

      const result = await db.query(`
        INSERT INTO products
        (
          name,
          brand,
          model,
          buy_price,
          sell_price,
          stock
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *
      `, [
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

    /*
      GET TRANSACTIONS
    */

    if (path === "/transactions" && method === "GET") {

      const result = await db.query(`
        SELECT
          t.id,
          t.type,
          t.quantity,
          t.unit_price,
          t.buy_price,
          t.total,
          t.created_at,
          p.name AS product_name
        FROM transactions t
        INNER JOIN products p
          ON p.id = t.product_id
        ORDER BY t.id DESC
        LIMIT 500
      `);

      return send(res, 200, {
        success: true,
        transactions: result.rows
      });

    }

    /*
      BUY
    */

    if (path === "/buy" && method === "POST") {

      const body = req.body || {};

      const productId = number(body.product_id);
      const quantity = number(body.quantity);
      const unitPrice = number(body.unit_price);

      if (
        productId === null ||
        !Number.isInteger(productId) ||
        productId <= 0
      ) {
        return send(res, 400, {
          success: false,
          error: "کالا انتخاب نشده است."
        });
      }

      if (
        quantity === null ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return send(res, 400, {
          success: false,
          error: "تعداد خرید نامعتبر است."
        });
      }

      if (
        unitPrice === null ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "قیمت خرید نامعتبر است."
        });
      }

      const client = await db.connect();

      try {

        await client.query("BEGIN");

        const productResult = await client.query(`
          SELECT *
          FROM products
          WHERE id = $1
          FOR UPDATE
        `, [productId]);

        if (!productResult.rows.length) {

          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "کالا پیدا نشد."
          });

        }

        const product = productResult.rows[0];

        const total = quantity * unitPrice;

        await client.query(`
          UPDATE products
          SET
            stock = stock + $1,
            buy_price = $2,
            updated_at = NOW()
          WHERE id = $3
        `, [
          quantity,
          unitPrice,
          productId
        ]);

        await client.query(`
          INSERT INTO transactions
          (
            product_id,
            type,
            quantity,
            unit_price,
            buy_price,
            total
          )
          VALUES ($1,'buy',$2,$3,$4,$5)
        `, [
          productId,
          quantity,
          unitPrice,
          unitPrice,
          total
        ]);

        await client.query("COMMIT");

        return send(res, 200, {
          success: true,
          message: "خرید ثبت شد.",
          total
        });

      } catch(error) {

        await client.query("ROLLBACK");
        throw error;

      } finally {

        client.release();

      }

    }

    /*
      SELL
    */

    if (path === "/sell" && method === "POST") {

      const body = req.body || {};

      const productId = number(body.product_id);
      const quantity = number(body.quantity);
      const unitPrice = number(body.unit_price);

      if (
        productId === null ||
        !Number.isInteger(productId) ||
        productId <= 0
      ) {
        return send(res, 400, {
          success: false,
          error: "کالا انتخاب نشده است."
        });
      }

      if (
        quantity === null ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return send(res, 400, {
          success: false,
          error: "تعداد فروش نامعتبر است."
        });
      }

      if (
        unitPrice === null ||
        unitPrice < 0
      ) {
        return send(res, 400, {
          success: false,
          error: "قیمت فروش نامعتبر است."
        });
      }

      const client = await db.connect();

      try {

        await client.query("BEGIN");

        const productResult = await client.query(`
          SELECT *
          FROM products
          WHERE id = $1
          FOR UPDATE
        `, [productId]);

        if (!productResult.rows.length) {

          await client.query("ROLLBACK");

          return send(res, 404, {
            success: false,
            error: "کالا پیدا نشد."
          });

        }

        const product = productResult.rows[0];

        if (Number(product.stock) < quantity) {

          await client.query("ROLLBACK");

          return send(res, 400, {
            success: false,
            error:
              `موجودی کافی نیست. موجودی فعلی: ${product.stock}`
          });

        }

        const buyPrice = Number(product.buy_price || 0);

        const total = quantity * unitPrice;

        await client.query(`
          UPDATE products
          SET
            stock = stock - $1,
            updated_at = NOW()
          WHERE id = $2
        `, [
          quantity,
          productId
        ]);

        await client.query(`
          INSERT INTO transactions
          (
            product_id,
            type,
            quantity,
            unit_price,
            buy_price,
            total
          )
          VALUES ($1,'sell',$2,$3,$4,$5)
        `, [
          productId,
          quantity,
          unitPrice,
          buyPrice,
          total
        ]);

        await client.query("COMMIT");

        const profit =
          (unitPrice - buyPrice) * quantity;

        return send(res, 200, {
          success: true,
          message: "فروش ثبت شد.",
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

    return send(res, 404, {
      success: false,
      error: "Endpoint not found."
    });

  } catch(error) {

    console.error("API ERROR:", error);

    return send(res, 500, {
      success: false,
      error: error.message || "خطای داخلی سرور"
    });

  }

};