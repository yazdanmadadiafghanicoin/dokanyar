const { Pool } = require("pg");
const crypto = require("crypto");

/* =========================================================
   CORS
========================================================= */

const ALLOWED_ORIGINS = [
  "https://yazdanmadadiafghanicoin.github.io",
  "https://yazdanmadadiafghanicoin.github.io/dokanyar",
  "http://localhost:3000",
  "http://localhost:5173"
];

function setCors(req, res) {
  const origin = req.headers.origin || "";

  if (
    origin === "https://yazdanmadadiafghanicoin.github.io" ||
    origin === "http://localhost:3000" ||
    origin === "http://localhost:5173"
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "https://yazdanmadadiafghanicoin.github.io"
    );
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-auth-token"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}


/* =========================================================
   DATABASE
========================================================= */

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL پیدا نشد. در Vercel قسمت Environment Variables را بررسی کنید."
    );
  }

  pool = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false
    },
    max: 5
  });

  return pool;
}


/* =========================================================
   PASSWORD
========================================================= */

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}


/* =========================================================
   TOKEN
========================================================= */

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}


/* =========================================================
   JSON
========================================================= */

function send(res, status, data) {
  res.status(status).json(data);
}


/* =========================================================
   BODY
========================================================= */

async function getBody(req) {
  if (req.body) {
    if (typeof req.body === "object") {
      return req.body;
    }

    try {
      return JSON.parse(req.body);
    } catch (e) {
      return {};
    }
  }

  return {};
}


/* =========================================================
   DATABASE SETUP
========================================================= */

async function setupDatabase() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'worker',
      token TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, username)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      buy_price NUMERIC(14,2) DEFAULT 0,
      sell_price NUMERIC(14,2) DEFAULT 0,
      quantity NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      quantity NUMERIC(14,2) DEFAULT 0,
      unit_price NUMERIC(14,2) DEFAULT 0,
      total NUMERIC(14,2) DEFAULT 0,
      buy_cost NUMERIC(14,2) DEFAULT 0,
      profit NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return true;
}


/* =========================================================
   AUTH
========================================================= */

async function getAuth(req) {
  const db = getPool();

  const auth =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  let token = "";

  if (auth.startsWith("Bearer ")) {
    token = auth.substring(7).trim();
  }

  if (!token) {
    token =
      req.headers["x-auth-token"] ||
      "";
  }

  if (!token) {
    return null;
  }

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

  if (!result.rows.length) {
    return null;
  }

  return result.rows[0];
}


/* =========================================================
   MAIN
========================================================= */

module.exports = async function handler(req, res) {

  setCors(req, res);

  /* OPTIONS */
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const path =
    (req.url || "")
      .split("?")[0]
      .replace(/^\/api/, "") || "/";

  try {

    /* =====================================================
       HEALTH
    ===================================================== */

    if (path === "/" && req.method === "GET") {

      let database = false;

      try {
        const db = getPool();
        await db.query("SELECT 1");
        database = true;
      } catch (e) {
        database = false;
      }

      return send(res, 200, {
        success: true,
        app: "Dokanyaar",
        message: "دوکان‌یار API فعال است.",
        database
      });
    }


    /* =====================================================
       SETUP
    ===================================================== */

    if (
      path === "/setup" &&
      (req.method === "GET" || req.method === "POST")
    ) {

      await setupDatabase();

      return send(res, 200, {
        success: true,
        message: "دیتابیس دوکان‌یار آماده است."
      });
    }


    /* =====================================================
       DATABASE
    ===================================================== */

    await setupDatabase();


    /* =====================================================
       REGISTER
    ===================================================== */

    if (path === "/register" && req.method === "POST") {

      const body = await getBody(req);

      const shop_name =
        String(body.shop_name || "").trim();

      const owner_name =
        String(body.owner_name || "").trim();

      const username =
        String(body.username || "").trim();

      const password =
        String(body.password || "");

      if (!shop_name || !owner_name || !username || !password) {

        return send(res, 400, {
          success: false,
          error: "تمام اطلاعات ثبت دوکان را وارد کنید."
        });
      }

      if (password.length < 4) {

        return send(res, 400, {
          success: false,
          error: "رمز عبور باید حداقل ۴ حرف باشد."
        });
      }

      const db = getPool();

      const existing =
        await db.query(
          `
          SELECT id
          FROM users
          WHERE LOWER(username) = LOWER($1)
          LIMIT 1
          `,
          [username]
        );

      if (existing.rows.length) {

        return send(res, 409, {
          success: false,
          error: "این نام کاربری قبلاً استفاده شده است."
        });
      }

      const shopResult =
        await db.query(
          `
          INSERT INTO shops
          (name, owner_name)
          VALUES ($1,$2)
          RETURNING id,name,owner_name
          `,
          [
            shop_name,
            owner_name
          ]
        );

      const shop =
        shopResult.rows[0];

      const token =
        createToken();

      const userResult =
        await db.query(
          `
          INSERT INTO users
          (
            shop_id,
            username,
            password_hash,
            full_name,
            role,
            token
          )
          VALUES ($1,$2,$3,$4,'owner',$5)
          RETURNING id,shop_id,username,full_name,role
          `,
          [
            shop.id,
            username,
            hashPassword(password),
            owner_name,
            token
          ]
        );

      const user =
        userResult.rows[0];

      return send(res, 201, {
        success: true,
        token,
        user,
        shop
      });
    }


    /* =====================================================
       LOGIN
    ===================================================== */

    if (path === "/login" && req.method === "POST") {

      const body = await getBody(req);

      const username =
        String(body.username || "").trim();

      const password =
        String(body.password || "");

      if (!username || !password) {

        return send(res, 400, {
          success: false,
          error: "نام کاربری و رمز عبور را وارد کنید."
        });
      }

      const db = getPool();

      const result =
        await db.query(
          `
          SELECT
            u.id,
            u.shop_id,
            u.username,
            u.full_name,
            u.role,
            u.password_hash,
            s.name AS shop_name,
            s.owner_name
          FROM users u
          JOIN shops s ON s.id = u.shop_id
          WHERE LOWER(u.username) = LOWER($1)
          LIMIT 1
          `,
          [username]
        );

      if (!result.rows.length) {

        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
      }

      const user =
        result.rows[0];

      if (
        user.password_hash !==
        hashPassword(password)
      ) {

        return send(res, 401, {
          success: false,
          error: "نام کاربری یا رمز عبور اشتباه است."
        });
      }

      const token =
        createToken();

      await db.query(
        `
        UPDATE users
        SET token = $1
        WHERE id = $2
        `,
        [
          token,
          user.id
        ]
      );

      delete user.password_hash;

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
        shop: {
          id: user.shop_id,
          name: user.shop_name,
          owner_name: user.owner_name
        }
      });
    }


    /* =====================================================
       AUTH REQUIRED
    ===================================================== */

    const auth =
      await getAuth(req);

    if (!auth) {

      return send(res, 401, {
        success: false,
        error: "لطفاً ابتدا وارد حساب شوید."
      });
    }


    /* =====================================================
       ME
    ===================================================== */

    if (path === "/me" && req.method === "GET") {

      return send(res, 200, {
        success: true,

        user: {
          id: auth.id,
          shop_id: auth.shop_id,
          username: auth.username,
          full_name: auth.full_name,
          role: auth.role
        },

        shop: {
          id: auth.shop_id,
          name: auth.shop_name,
          owner_name: auth.owner_name
        }
      });
    }


    /* =====================================================
       LOGOUT
    ===================================================== */

    if (path === "/logout" && req.method === "POST") {

      const db = getPool();

      await db.query(
        `
        UPDATE users
        SET token = NULL
        WHERE id = $1
        `,
        [auth.id]
      );

      return send(res, 200, {
        success: true,
        message: "با موفقیت خارج شدید."
      });
    }


    /* =====================================================
       SHOP
    ===================================================== */

    if (path === "/shop" && req.method === "GET") {

      const db = getPool();

      const result =
        await db.query(
          `
          SELECT id,name,owner_name,created_at
          FROM shops
          WHERE id = $1
          `,
          [auth.shop_id]
        );

      return send(res, 200, {
        success: true,
        shop: result.rows[0] || null
      });
    }


    if (path === "/shop" && req.method === "PUT") {

      const body = await getBody(req);

      const name =
        String(body.name || "").trim();

      const owner_name =
        String(body.owner_name || "").trim();

      if (!name) {

        return send(res, 400, {
          success: false,
          error: "نام دوکان الزامی است."
        });
      }

      const db = getPool();

      const result =
        await db.query(
          `
          UPDATE shops
          SET
            name = $1,
            owner_name = $2
          WHERE id = $3
          RETURNING id,name,owner_name
          `,
          [
            name,
            owner_name,
            auth.shop_id
          ]
        );

      return send(res, 200, {
        success: true,
        shop: result.rows[0]
      });
    }


    /* =====================================================
       PRODUCTS - GET
    ===================================================== */

    if (path === "/products" && req.method === "GET") {

      const db = getPool();

      const result =
        await db.query(
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
          [auth.shop_id]
        );

      return send(res, 200, {
        success: true,
        products: result.rows
      });
    }


    /* =====================================================
       PRODUCTS - POST
    ===================================================== */

    if (path === "/products" && req.method === "POST") {

      const body = await getBody(req);

      const name =
        String(body.name || "").trim();

      const brand =
        String(body.brand || "").trim();

      const model =
        String(body.model || "").trim();

      const buy_price =
        Number(body.buy_price || 0);

      const sell_price =
        Number(body.sell_price || 0);

      const quantity =
        Number(body.quantity || 0);

      if (!name) {

        return send(res, 400, {
          success: false,
          error: "نام محصول الزامی است."
        });
      }

      if (
        buy_price < 0 ||
        sell_price < 0 ||
        quantity < 0
      ) {

        return send(res, 400, {
          success: false,
          error: "قیمت یا تعداد نامعتبر است."
        });
      }

      const db = getPool();

      const result =
        await db.query(
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
          VALUES
          ($1,$2,$3,$4,$5,$6,$7)
          RETURNING *
          `,
          [
            auth.shop_id,
            name,
            brand,
            model,
            buy_price,
            sell_price,
            quantity
          ]
        );

      return send(res, 201, {
        success: true,
        product: result.rows[0]
      });
    }


    /* =====================================================
       PRODUCT ID
    ===================================================== */

    const productMatch =
      path.match(/^\/products\/(\d+)$/);


    /* =====================================================
       PRODUCT UPDATE
    ===================================================== */

    if (
      productMatch &&
      req.method === "PUT"
    ) {

      const productId =
        Number(productMatch[1]);

      const body =
        await getBody(req);

      const name =
        String(body.name || "").trim();

      const brand =
        String(body.brand || "").trim();

      const model =
        String(body.model || "").trim();

      const buy_price =
        Number(body.buy_price || 0);

      const sell_price =
        Number(body.sell_price || 0);

      const quantity =
        Number(body.quantity || 0);

      if (!name) {

        return send(res,400,{
          success:false,
          error:"نام محصول الزامی است."
        });
      }

      const db = getPool();

      const result =
        await db.query(
          `
          UPDATE products
          SET
            name = $1,
            brand = $2,
            model = $3,
            buy_price = $4,
            sell_price = $5,
            quantity = $6,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $7
          AND shop_id = $8
          RETURNING *
          `,
          [
            name,
            brand,
            model,
            buy_price,
            sell_price,
            quantity,
            productId,
            auth.shop_id
          ]
        );

      if (!result.rows.length) {

        return send(res,404,{
          success:false,
          error:"محصول پیدا نشد."
        });
      }

      return send(res,200,{
        success:true,
        product:result.rows[0]
      });
    }


    /* =====================================================
       PRODUCT DELETE
    ===================================================== */

    if (
      productMatch &&
      req.method === "DELETE"
    ) {

      const productId =
        Number(productMatch[1]);

      const db = getPool();

      const result =
        await db.query(
          `
          DELETE FROM products
          WHERE id = $1
          AND shop_id = $2
          RETURNING id
          `,
          [
            productId,
            auth.shop_id
          ]
        );

      if (!result.rows.length) {

        return send(res,404,{
          success:false,
          error:"محصول پیدا نشد."
        });
      }

      return send(res,200,{
        success:true,
        message:"محصول حذف شد."
      });
    }


    /* =====================================================
       BUY
    ===================================================== */

    if (path === "/buy" && req.method === "POST") {

      const body =
        await getBody(req);

      const product_id =
        Number(body.product_id);

      const quantity =
        Number(body.quantity);

      const unit_price =
        Number(body.unit_price);

      if (
        !product_id ||
        quantity <= 0 ||
        unit_price < 0
      ) {

        return send(res,400,{
          success:false,
          error:"اطلاعات خرید نامعتبر است."
        });
      }

      const db = getPool();

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const productResult =
          await client.query(
            `
            SELECT *
            FROM products
            WHERE id = $1
            AND shop_id = $2
            FOR UPDATE
            `,
            [
              product_id,
              auth.shop_id
            ]
          );

        if(!productResult.rows.length){

          await client.query("ROLLBACK");

          return send(res,404,{
            success:false,
            error:"محصول پیدا نشد."
          });
        }

        const product =
          productResult.rows[0];

        const oldQty =
          Number(product.quantity || 0);

        const oldBuy =
          Number(product.buy_price || 0);

        /* Weighted Average */

        const newAverage =
          oldQty + quantity > 0
            ? (
                (
                  oldQty * oldBuy
                ) +
                (
                  quantity * unit_price
                )
              ) /
              (
                oldQty + quantity
              )
            : unit_price;

        const newQty =
          oldQty + quantity;

        await client.query(
          `
          UPDATE products
          SET
            quantity = $1,
            buy_price = $2,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
          AND shop_id = $4
          `,
          [
            newQty,
            newAverage,
            product_id,
            auth.shop_id
          ]
        );

        const total =
          quantity * unit_price;

        const transaction =
          await client.query(
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
              profit
            )
            VALUES
            ($1,$2,$3,'buy',$4,$5,$6,$7,0)
            RETURNING *
            `,
            [
              auth.shop_id,
              product_id,
              auth.id,
              quantity,
              unit_price,
              total,
              quantity * unit_price
            ]
          );

        await client.query("COMMIT");

        return send(res,200,{
          success:true,
          transaction:transaction.rows[0],
          average_buy_price:newAverage,
          new_quantity:newQty
        });

      }catch(error){

        await client.query("ROLLBACK");

        throw error;

      }finally{

        client.release();
      }
    }


    /* =====================================================
       SELL
    ===================================================== */

    if (path === "/sell" && req.method === "POST") {

      const body =
        await getBody(req);

      const product_id =
        Number(body.product_id);

      const quantity =
        Number(body.quantity);

      const unit_price =
        Number(body.unit_price);

      if (
        !product_id ||
        quantity <= 0 ||
        unit_price < 0
      ) {

        return send(res,400,{
          success:false,
          error:"اطلاعات فروش نامعتبر است."
        });
      }

      const db = getPool();

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const productResult =
          await client.query(
            `
            SELECT *
            FROM products
            WHERE id = $1
            AND shop_id = $2
            FOR UPDATE
            `,
            [
              product_id,
              auth.shop_id
            ]
          );

        if(!productResult.rows.length){

          await client.query("ROLLBACK");

          return send(res,404,{
            success:false,
            error:"محصول پیدا نشد."
          });
        }

        const product =
          productResult.rows[0];

        const stock =
          Number(product.quantity || 0);

        const averageBuy =
          Number(product.buy_price || 0);

        if(quantity > stock){

          await client.query("ROLLBACK");

          return send(res,400,{
            success:false,
            error:
              "موجودی کافی نیست. موجودی فعلی: " +
              stock
          });
        }

        const newStock =
          stock - quantity;

        const total =
          quantity * unit_price;

        const buyCost =
          quantity * averageBuy;

        const profit =
          total - buyCost;

        await client.query(
          `
          UPDATE products
          SET
            quantity = $1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          AND shop_id = $3
          `,
          [
            newStock,
            product_id,
            auth.shop_id
          ]
        );

        const transaction =
          await client.query(
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
              profit
            )
            VALUES
            ($1,$2,$3,'sell',$4,$5,$6,$7,$8)
            RETURNING *
            `,
            [
              auth.shop_id,
              product_id,
              auth.id,
              quantity,
              unit_price,
              total,
              buyCost,
              profit
            ]
          );

        await client.query("COMMIT");

        return send(res,200,{
          success:true,
          transaction:transaction.rows[0],
          profit,
          new_quantity:newStock
        });

      }catch(error){

        await client.query("ROLLBACK");

        throw error;

      }finally{

        client.release();
      }
    }


    /* =====================================================
       TRANSACTIONS
    ===================================================== */

    if (
      path === "/transactions" &&
      req.method === "GET"
    ) {

      const db = getPool();

      const result =
        await db.query(
          `
          SELECT
            t.id,
            t.type,
            t.quantity,
            t.unit_price,
            t.total,
            t.buy_cost,
            t.profit,
            t.created_at,
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
          [auth.shop_id]
        );

      return send(res,200,{
        success:true,
        transactions:result.rows
      });
    }


    /* =====================================================
       WORKERS GET
    ===================================================== */

    if (
      path === "/workers" &&
      req.method === "GET"
    ) {

      const db = getPool();

      const result =
        await db.query(
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
          [auth.shop_id]
        );

      return send(res,200,{
        success:true,
        workers:result.rows
      });
    }


    /* =====================================================
       WORKERS POST
    ===================================================== */

    if (
      path === "/workers" &&
      req.method === "POST"
    ) {

      if(auth.role !== "owner"){

        return send(res,403,{
          success:false,
          error:"فقط صاحب دوکان می‌تواند کارمند اضافه کند."
        });
      }

      const body =
        await getBody(req);

      const username =
        String(body.username || "").trim();

      const full_name =
        String(
          body.full_name ||
          body.name ||
          ""
        ).trim();

      const password =
        String(body.password || "");

      if(
        !username ||
        !full_name ||
        !password
      ){

        return send(res,400,{
          success:false,
          error:"تمام اطلاعات کارمند را وارد کنید."
        });
      }

      if(password.length < 4){

        return send(res,400,{
          success:false,
          error:"رمز عبور حداقل ۴ حرف باشد."
        });
      }

      const db = getPool();

      const exists =
        await db.query(
          `
          SELECT id
          FROM users
          WHERE shop_id = $1
          AND LOWER(username) = LOWER($2)
          `,
          [
            auth.shop_id,
            username
          ]
        );

      if(exists.rows.length){

        return send(res,409,{
          success:false,
          error:"این نام کاربری قبلاً استفاده شده است."
        });
      }

      const result =
        await db.query(
          `
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
            shop_id,
            username,
            full_name,
            role,
            created_at
          `,
          [
            auth.shop_id,
            username,
            hashPassword(password),
            full_name
          ]
        );

      return send(res,201,{
        success:true,
        worker:result.rows[0]
      });
    }


    /* =====================================================
       WORKER DELETE
    ===================================================== */

    const workerMatch =
      path.match(/^\/workers\/(\d+)$/);

    if(
      workerMatch &&
      req.method === "DELETE"
    ){

      if(auth.role !== "owner"){

        return send(res,403,{
          success:false,
          error:"فقط صاحب دوکان می‌تواند کارمند حذف کند."
        });
      }

      const workerId =
        Number(workerMatch[1]);

      if(workerId === auth.id){

        return send(res,400,{
          success:false,
          error:"حساب خودتان را نمی‌توانید حذف کنید."
        });
      }

      const db = getPool();

      const result =
        await db.query(
          `
          DELETE FROM users
          WHERE id = $1
          AND shop_id = $2
          AND role = 'worker'
          RETURNING id
          `,
          [
            workerId,
            auth.shop_id
          ]
        );

      if(!result.rows.length){

        return send(res,404,{
          success:false,
          error:"کارمند پیدا نشد."
        });
      }

      return send(res,200,{
        success:true,
        message:"کارمند حذف شد."
      });
    }


    /* =====================================================
       DASHBOARD
    ===================================================== */

    if (
      path === "/dashboard" &&
      req.method === "GET"
    ) {

      const db = getPool();

      const productsResult =
        await db.query(
          `
          SELECT
            COUNT(*) AS products_count,
            COALESCE(
              SUM(quantity * buy_price),
              0
            ) AS inventory_value,
            COUNT(
              CASE
                WHEN quantity <= 5
                THEN 1
              END
            ) AS low_stock_count
          FROM products
          WHERE shop_id = $1
          `,
          [auth.shop_id]
        );

      const transactionResult =
        await db.query(
          `
          SELECT

            COALESCE(
              SUM(
                CASE
                  WHEN type = 'buy'
                  THEN total
                  ELSE 0
                END
              ),
              0
            ) AS total_buy,

            COALESCE(
              SUM(
                CASE
                  WHEN type = 'sell'
                  THEN total
                  ELSE 0
                END
              ),
              0
            ) AS total_sell,

            COALESCE(
              SUM(profit),
              0
            ) AS total_profit,

            COUNT(
              CASE
                WHEN type = 'buy'
                THEN 1
              END
            ) AS buy_count,

            COUNT(
              CASE
                WHEN type = 'sell'
                THEN 1
              END
            ) AS sales_count

          FROM transactions

          WHERE shop_id = $1
          `,
          [auth.shop_id]
        );

      const p =
        productsResult.rows[0];

      const t =
        transactionResult.rows[0];

      return send(res,200,{

        success:true,

        dashboard:{

          products_count:
            Number(p.products_count || 0),

          inventory_value:
            Number(p.inventory_value || 0),

          low_stock_count:
            Number(p.low_stock_count || 0),

          total_buy:
            Number(t.total_buy || 0),

          total_sell:
            Number(t.total_sell || 0),

          total_profit:
            Number(t.total_profit || 0),

          buy_count:
            Number(t.buy_count || 0),

          sales_count:
            Number(t.sales_count || 0)

        }

      });
    }


    /* =====================================================
       NOT FOUND
    ===================================================== */

    return send(res,404,{
      success:false,
      error:"Endpoint not found.",
      path
    });


  } catch(error) {

    console.error("DOKANYAAR API ERROR:",error);

    return send(res,500,{
      success:false,
      error:
        error.message ||
        "خطای داخلی سرور."
    });
  }
};