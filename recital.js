// ── Chunk helper: splits any IN() query into safe batches of 99 ──
async function _inQuery(env, ids, sql, extraBinds = []) {
  if (!ids.length) return [];
  const CHUNK = 99;
  const all = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const ph    = chunk.map(() => "?").join(",");
    const res   = await env.db.prepare(sql.replace("__IN__", ph))
                    .bind(...extraBinds, ...chunk).all();
    all.push(...(res.results || []));
  }
  return all;
}

// ── CORS headers (used everywhere) ──
const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname.includes("/recital/catalog")) {
      return handleCatalog(request, env);
    }
    if (url.pathname.includes("/recital/pasuram-lookup")) {
      return handlePasuramLookup(request, env);
    }
    if (url.pathname.includes("/recital/plan")) {
      return handlePlan(request, env);
    }
    if (url.pathname.includes("/recital/render")) {
      return handleRender(request, env);
    }
    if (url.pathname.includes("/recital/ghoshti")) {
      return handleGhoshti(request, env);
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  }
};

// ── CATALOG: sections / pathus / thirumozhi ──────────────────────

async function handleCatalog(request, env) {
  const url = new URL(request.url);

  try {

    // ── Level 1: GET /recital/catalog → all thousands + sections ──
    if (!url.searchParams.has("section_id") && !url.searchParams.has("pathu_id")) {

      const [thousands, sections] = await Promise.all([
        env.db.prepare(`
          SELECT thousand_id, canonical_name
          FROM thousands_master
          ORDER BY sequence_no
        `).all(),

        env.db.prepare(`
          SELECT section_id, section_name, thousand_id
          FROM section_master
          ORDER BY section_id
        `).all()
      ]);

      // Group sections under their thousand
      const result = thousands.results.map(t => ({
        thousand_id:   t.thousand_id,
        thousand_name: t.canonical_name,
        sections: sections.results
          .filter(s => s.thousand_id === t.thousand_id)
          .map(s => ({
            section_id:   s.section_id,
            section_name: s.section_name
          }))
      }));

      return new Response(JSON.stringify(result), { headers: CORS });
    }

    // ── Level 2: GET /recital/catalog?section_id= → pathus ──
    if (url.searchParams.has("section_id")) {
      const section_id = url.searchParams.get("section_id");

      const result = await env.db.prepare(`
        SELECT DISTINCT pathu_id, pathu_name, pathu_no
        FROM pathu_master
        WHERE section_id = ?
        ORDER BY pathu_no
      `).bind(Number(section_id)).all();

      return new Response(JSON.stringify(result.results), { headers: CORS });
    }

    // ── Level 3: GET /recital/catalog?pathu_id= → thirumozhi ──
    if (url.searchParams.has("pathu_id")) {
      const pathu_id = url.searchParams.get("pathu_id");

      const result = await env.db.prepare(`
        SELECT thirumozhi_id, thirumozhi_name, thirumozhi_no,
               thirumozhi_heading, global_no_start, global_no_end
        FROM thirumozhi_master
        WHERE pathu_id = ?
        ORDER BY thirumozhi_no
      `).bind(Number(pathu_id)).all();

      return new Response(JSON.stringify(result.results), { headers: CORS });
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: CORS
    });
  }
}

// ── PASURAM LOOKUP: resolve pasuram by global_no ─────────────────

async function handlePasuramLookup(request, env) {
  const url = new URL(request.url);
  const no  = url.searchParams.get("no");

  try {

    if (!no || isNaN(Number(no))) {
      return new Response(JSON.stringify({ error: "no= param required" }), {
        status: 400, headers: CORS
      });
    }

    const row = await env.db.prepare(`
      SELECT
        p.global_no,
        p.local_pasuram_no,
        p.section_id,
        p.pathu_id,
        p.thirumozhi_id,
        s.section_name,
        pm.pathu_name,
        pm.pathu_no,
        tm.thirumozhi_name,
        tm.thirumozhi_no,
        tm.thirumozhi_heading
      FROM pasuram_master p
      LEFT JOIN section_master s
        ON p.section_id = s.section_id
      LEFT JOIN pathu_master pm
        ON p.pathu_id = pm.pathu_id
      LEFT JOIN thirumozhi_master tm
        ON p.thirumozhi_id = tm.thirumozhi_id
      WHERE p.global_no = ?
      LIMIT 1
    `).bind(Number(no)).first();

    if (!row) {
      return new Response(JSON.stringify({ error: "Pasuram not found" }), {
        status: 404, headers: CORS
      });
    }

    return new Response(JSON.stringify(row), { headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: CORS
    });
  }
}

// ── PLAN: fetch and save user recital plan ────────────────────────

async function handlePlan(request, env) {
  const url = new URL(request.url);

  try {

    // ── GET /recital/plan?mobile=&day= → fetch plan for a day ──
    if (request.method === "GET") {
      const mobile = url.searchParams.get("mobile");
      const day    = url.searchParams.get("day");

      if (!mobile || day === null) {
        return new Response(JSON.stringify({ error: "mobile= and day= required" }), {
          status: 400, headers: CORS
        });
      }

      // Fetch plan — try exact day first, fall back to "all days" (7)
      const plan = await env.db.prepare(`
        SELECT plan_id, plan_name, day_of_week, is_active
        FROM user_recital_plan
        WHERE mobile = ?
          AND day_of_week IN (?, 7)
          AND is_active = 1
        ORDER BY day_of_week ASC
        LIMIT 1
      `).bind(mobile, Number(day)).first();

      if (!plan) {
        return new Response(JSON.stringify({ plan: null, items: [] }), {
          headers: CORS
        });
      }

      // Fetch items for this plan
      const items = await env.db.prepare(`
        SELECT item_id, sequence_no, entity_type, entity_id
        FROM user_recital_item
        WHERE plan_id = ?
        ORDER BY sequence_no
      `).bind(plan.plan_id).all();

      return new Response(JSON.stringify({
        plan,
        items: items.results
      }), { headers: CORS });
    }

    // ── POST /recital/plan → save/update plan ──
    if (request.method === "POST") {
      const body = await request.json();
      const { mobile, day_of_week, plan_name, items } = body;

      if (!mobile || day_of_week === undefined || !items) {
        return new Response(JSON.stringify({ error: "mobile, day_of_week, items required" }), {
          status: 400, headers: CORS
        });
      }

      // Upsert plan
      await env.db.prepare(`
        INSERT INTO user_recital_plan (mobile, day_of_week, plan_name, is_active, updated_at)
        VALUES (?, ?, ?, 1, datetime('now'))
        ON CONFLICT(mobile, day_of_week)
        DO UPDATE SET
          plan_name  = excluded.plan_name,
          is_active  = 1,
          updated_at = datetime('now')
      `).bind(mobile, day_of_week, plan_name || null).run();

      // Get plan_id
      const plan = await env.db.prepare(`
        SELECT plan_id FROM user_recital_plan
        WHERE mobile = ? AND day_of_week = ?
      `).bind(mobile, day_of_week).first();

      const plan_id = plan.plan_id;

      // Delete existing items and reinsert in order
      await env.db.prepare(`
        DELETE FROM user_recital_item WHERE plan_id = ?
      `).bind(plan_id).run();

      // Insert items one by one in sequence
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await env.db.prepare(`
          INSERT INTO user_recital_item
            (plan_id, sequence_no, entity_type, entity_id)
          VALUES (?, ?, ?, ?)
        `).bind(plan_id, i + 1, item.entity_type, item.entity_id).run();
      }

      return new Response(JSON.stringify({ success: true, plan_id }), {
        headers: CORS
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: CORS
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: CORS
    });
  }
}

// ── RENDER: full recital content with thaniyan + sattrumurai ─────

async function handleRender(request, env) {
  const url     = new URL(request.url);
  const plan_id = url.searchParams.get("plan_id");

  try {

    if (!plan_id) {
      return new Response(JSON.stringify({ error: "plan_id= required" }), {
        status: 400, headers: CORS
      });
    }

    // ── Step 1: fetch plan items + global thaniyan + sattrumurai eligibility simultaneously ──
    const [itemRows, globalThaniyanRows, sattrumuraiRows] = await Promise.all([
      env.db.prepare(`
        SELECT item_id, sequence_no, entity_type, entity_id
        FROM user_recital_item
        WHERE plan_id = ?
        ORDER BY sequence_no
      `).bind(Number(plan_id)).all(),

      env.db.prepare(`
        SELECT t.thaniyan_id, t.canonical_name, l.line_no, l.line_text
        FROM thaniyan_master t
        JOIN thaniyan_line_master l ON t.thaniyan_id = l.thaniyan_ref
        WHERE t.thaniyan_type = 'global'
        ORDER BY l.line_no
      `).all(),

      env.db.prepare(`
        SELECT entity_type, entity_id
        FROM recital_sattrumurai
      `).all()
    ]);

    const items = itemRows.results;
    if (!items.length) {
      return new Response(JSON.stringify({ blocks: [] }), { headers: CORS });
    }

    // ── Step 2: build sattrumurai lookup set ──
    const sattrumuraiSet = new Set(
      sattrumuraiRows.results.map(r => `${r.entity_type}:${r.entity_id}`)
    );

    // ── Step 3: resolve section_id for all items simultaneously ──
    const sectionIds    = new Array(items.length).fill(null);
    const sectionLookup = items.map((item, i) => {
      if (item.entity_type === "section") {
        sectionIds[i] = item.entity_id;
        return Promise.resolve();
      } else if (item.entity_type === "pathu") {
        return env.db.prepare(`
          SELECT section_id FROM pathu_master WHERE pathu_id = ? LIMIT 1
        `).bind(item.entity_id).first().then(r => { if (r) sectionIds[i] = r.section_id; });
      } else if (item.entity_type === "thirumozhi") {
        return env.db.prepare(`
          SELECT section_id FROM thirumozhi_master WHERE thirumozhi_id = ? LIMIT 1
        `).bind(item.entity_id).first().then(r => { if (r) sectionIds[i] = r.section_id; });
      } else if (item.entity_type === "pasuram") {
        return env.db.prepare(`
          SELECT section_id FROM pasuram_master WHERE global_no = ? LIMIT 1
        `).bind(item.entity_id).first().then(r => { if (r) sectionIds[i] = r.section_id; });
      }
      return Promise.resolve();
    });
    await Promise.all(sectionLookup);

    // ── Step 4: fetch all unique section thaniyans simultaneously ──
    const uniqueSectionIds = [...new Set(sectionIds.filter(Boolean))];
    const sectionThaniyans = {};
    await Promise.all(uniqueSectionIds.map(sid =>
      env.db.prepare(`
        SELECT t.thaniyan_id, t.canonical_name, l.line_no, l.line_text
        FROM thaniyan_master t
        JOIN thaniyan_line_master l ON t.thaniyan_id = l.thaniyan_ref
        WHERE t.thaniyan_type = 'section' AND t.section_id = ?
        ORDER BY l.line_no
      `).bind(sid).all().then(rows => {
        if (rows.results.length) sectionThaniyans[sid] = rows.results;
      })
    ));

    // ── Step 5: fetch all pasurams for all items simultaneously ──
    const pasuramResults = await Promise.all(items.map(item => {
      if (item.entity_type === "section") {
        return env.db.prepare(`
          SELECT p.global_no, p.local_pasuram_no, p.double_recital,
                 l.line_no, l.line_text, l.recital_group
          FROM pasuram_master p
          JOIN pasuram_line_master l ON p.global_no = l.global_no
          WHERE p.section_id = ?
          ORDER BY p.global_no, l.line_no
        `).bind(item.entity_id).all().then(r => r.results);

      } else if (item.entity_type === "pathu") {
        return env.db.prepare(`
          SELECT p.global_no, p.local_pasuram_no, p.double_recital,
                 l.line_no, l.line_text, l.recital_group
          FROM pasuram_master p
          JOIN pasuram_line_master l ON p.global_no = l.global_no
          WHERE p.pathu_id = ?
          ORDER BY p.global_no, l.line_no
        `).bind(item.entity_id).all().then(r => r.results);

      } else if (item.entity_type === "thirumozhi") {
        return env.db.prepare(`
          SELECT p.global_no, p.local_pasuram_no, p.double_recital,
                 l.line_no, l.line_text, l.recital_group
          FROM pasuram_master p
          JOIN pasuram_line_master l ON p.global_no = l.global_no
          WHERE p.thirumozhi_id = ?
          ORDER BY p.global_no, l.line_no
        `).bind(item.entity_id).all().then(r => r.results);

      } else if (item.entity_type === "pasuram") {
        return env.db.prepare(`
          SELECT p.global_no, p.local_pasuram_no, p.double_recital,
                 l.line_no, l.line_text, l.recital_group
          FROM pasuram_master p
          JOIN pasuram_line_master l ON p.global_no = l.global_no
          WHERE p.global_no = ?
          ORDER BY l.line_no
        `).bind(item.entity_id).all().then(r => r.results);
      }
      return Promise.resolve([]);
    }));

    // ── Step 6: fetch sattrumurai sequences for eligible items simultaneously ──
    const sattrumuraiData = await Promise.all(items.map((item, i) => {
      const key = `${item.entity_type}:${item.entity_id}`;
      if (!sattrumuraiSet.has(key) || !sectionIds[i]) return Promise.resolve(null);
      return env.db.prepare(`
        SELECT ss.sequence_no, ss.entity_type, ss.entity_id, ss.is_dual_recital
        FROM sattrumurai_sequence ss
        JOIN sattrumurai_master sm ON ss.sattrumurai_id = sm.sattrumurai_id
        WHERE sm.thousand_id = (
          SELECT thousand_id FROM section_master WHERE section_id = ? LIMIT 1
        )
        ORDER BY ss.sequence_no
      `).bind(sectionIds[i]).all().then(r => r.results.length ? r.results : null);
    }));

    // ── Step 7: build output blocks ──
    const blocks = [];
    const shownSectionThaniyans = new Set();

    // Global thaniyan block
    if (globalThaniyanRows.results.length) {
      blocks.push({
        block_type: "global_thaniyan",
        lines:      globalThaniyanRows.results
      });
    }

    // Process each item
    for (let i = 0; i < items.length; i++) {
      const item      = items[i];
      const section_id = sectionIds[i];

      // Section thaniyan — once per section
      if (section_id && !shownSectionThaniyans.has(section_id)) {
        if (sectionThaniyans[section_id]) {
          blocks.push({
            block_type: "section_thaniyan",
            section_id,
            lines:      sectionThaniyans[section_id]
          });
        }
        shownSectionThaniyans.add(section_id);
      }

      // Pasuram block
      if (pasuramResults[i].length) {
        blocks.push({
          block_type:  "pasurams",
          entity_type: item.entity_type,
          entity_id:   item.entity_id,
          sequence_no: item.sequence_no,
          pasurams:    pasuramResults[i]
        });
      }

      // Sattrumurai block
      if (sattrumuraiData[i]) {
        blocks.push({
          block_type:  "sattrumurai",
          entity_type: item.entity_type,
          entity_id:   item.entity_id,
          items:       sattrumuraiData[i]
        });
      }
    }

    return new Response(JSON.stringify({ plan_id: Number(plan_id), blocks }), {
      headers: CORS
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: CORS
    });
  }
}

// ── GHOSHTI: create, edit and render group recital sessions ──────

async function handleGhoshti(request, env) {
  const url = new URL(request.url);

  try {

    // ── POST /recital/ghoshti → create ghoshti session ──
    if (request.method === "POST") {
      const body = await request.json();
      const { plan_id, mobile, ghoshti_name, start_time } = body;

      if (!plan_id || !mobile || !start_time) {
        return new Response(JSON.stringify({
          error: "plan_id, mobile, start_time required"
        }), { status: 400, headers: CORS });
      }

      // Verify plan belongs to this mobile
      const plan = await env.db.prepare(`
        SELECT plan_id FROM user_recital_plan
        WHERE plan_id = ? AND mobile = ? AND is_active = 1
      `).bind(Number(plan_id), mobile).first();

      if (!plan) {
        return new Response(JSON.stringify({
          error: "Plan not found or not authorized"
        }), { status: 403, headers: CORS });
      }

      // Generate short ghoshti_id (6 char)
      const ghoshti_id = Math.random().toString(36).substring(2, 8);

      // expires_at = midnight of day after ghoshti date + 12 hours
      // e.g. ghoshti on 10/6/2026 → midnight 11/6/2026 00:00 + 12hrs → 11/6/2026 12:00 noon
      const ghoshtiDate = new Date(start_time);
      const nextDay     = new Date(ghoshtiDate);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);  // midnight of next day
      const expiresAt   = new Date(nextDay.getTime() + 12 * 60 * 60 * 1000); // + 12 hours
      const expires_at  = expiresAt.toISOString();

      await env.db.prepare(`
        INSERT INTO ghoshti_session
          (ghoshti_id, plan_id, mobile, ghoshti_name, start_time, expires_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).bind(
        ghoshti_id,
        Number(plan_id),
        mobile,
        ghoshti_name || null,
        start_time,
        expires_at
      ).run();

      return new Response(JSON.stringify({
        success:    true,
        ghoshti_id,
        link:       `https://arulicheyal.org/ghoshti?id=${ghoshti_id}`,
        expires_at
      }), { headers: CORS });
    }

    // ── PUT /recital/ghoshti → edit ghoshti (creator only, before ghoshti day) ──
    if (request.method === "PUT") {
      const body = await request.json();
      const { ghoshti_id, mobile, ghoshti_name, start_time, plan_id } = body;

      if (!ghoshti_id || !mobile) {
        return new Response(JSON.stringify({
          error: "ghoshti_id and mobile required"
        }), { status: 400, headers: CORS });
      }

      // Fetch session
      const session = await env.db.prepare(`
        SELECT ghoshti_id, mobile, start_time, is_active
        FROM ghoshti_session
        WHERE ghoshti_id = ?
      `).bind(ghoshti_id).first();

      if (!session) {
        return new Response(JSON.stringify({ error: "Ghoshti session not found" }), {
          status: 404, headers: CORS
        });
      }

      // Verify creator
      if (session.mobile !== mobile) {
        return new Response(JSON.stringify({ error: "Not authorized" }), {
          status: 403, headers: CORS
        });
      }

      // Block edit on ghoshti day or after
      const today      = new Date();
      const ghoshtiDay = new Date(session.start_time);
      today.setHours(0, 0, 0, 0);
      ghoshtiDay.setHours(0, 0, 0, 0);
      if (today >= ghoshtiDay) {
        return new Response(JSON.stringify({
          error: "Editing is not allowed on or after ghoshti day"
        }), { status: 403, headers: CORS });
      }

      // If new start_time provided recalculate expires_at
      let new_expires_at = null;
      if (start_time) {
        const newGhoshtiDate = new Date(start_time);
        const newNextDay     = new Date(newGhoshtiDate);
        newNextDay.setDate(newNextDay.getDate() + 1);
        newNextDay.setHours(0, 0, 0, 0);
        const newExpiry  = new Date(newNextDay.getTime() + 12 * 60 * 60 * 1000);
        new_expires_at   = newExpiry.toISOString();
      }

      // Update session
      await env.db.prepare(`
        UPDATE ghoshti_session SET
          ghoshti_name = COALESCE(?, ghoshti_name),
          start_time   = COALESCE(?, start_time),
          expires_at   = COALESCE(?, expires_at),
          plan_id      = COALESCE(?, plan_id)
        WHERE ghoshti_id = ?
      `).bind(
        ghoshti_name || null,
        start_time   || null,
        new_expires_at,
        plan_id ? Number(plan_id) : null,
        ghoshti_id
      ).run();

      return new Response(JSON.stringify({
        success:    true,
        ghoshti_id,
        expires_at: new_expires_at
      }), { headers: CORS });
    }

    // ── GET /recital/ghoshti?id=&mobile= → render ghoshti content ──
    if (request.method === "GET") {
      const id     = url.searchParams.get("id");
      const mobile = url.searchParams.get("mobile");

      if (!id) {
        return new Response(JSON.stringify({ error: "id= required" }), {
          status: 400, headers: CORS
        });
      }

      // Fetch session
      const session = await env.db.prepare(`
        SELECT ghoshti_id, plan_id, mobile, ghoshti_name,
               start_time, expires_at, is_active
        FROM ghoshti_session
        WHERE ghoshti_id = ?
      `).bind(id).first();

      if (!session) {
        return new Response(JSON.stringify({ error: "Ghoshti session not found" }), {
          status: 404, headers: CORS
        });
      }

      // Check expiry
      const now = new Date();
      const exp = new Date(session.expires_at);
      if (now > exp || !session.is_active) {
        return new Response(JSON.stringify({
          expired: true,
          message: "This ghoshti session has ended"
        }), { headers: CORS });
      }

      // Check if today is ghoshti day or later — only then allow public view
      const today      = new Date();
      const ghoshtiDay = new Date(session.start_time);
      today.setHours(0, 0, 0, 0);
      ghoshtiDay.setHours(0, 0, 0, 0);

      const isCreator  = mobile && mobile === session.mobile;
      const isGhoshtiDay = today >= ghoshtiDay;

      // Before ghoshti day — only creator can view
      if (!isGhoshtiDay && !isCreator) {
        return new Response(JSON.stringify({
          error: "This ghoshti is not yet open for viewing"
        }), { status: 403, headers: CORS });
      }

      // Fetch host name
      const host = await env.db.prepare(`
        SELECT name FROM user_master WHERE mobile = ? LIMIT 1
      `).bind(session.mobile).first();

      // Render content
      const renderUrl     = new URL(request.url);
      renderUrl.pathname  = "/recital/render";
      renderUrl.search    = `?plan_id=${session.plan_id}`;
      const renderRequest  = new Request(renderUrl.toString(), { method: "GET" });
      const renderResponse = await handleRender(renderRequest, env);
      const renderData     = await renderResponse.json();

      return new Response(JSON.stringify({
        ghoshti_id:   session.ghoshti_id,
        ghoshti_name: session.ghoshti_name,
        start_time:   session.start_time,
        expires_at:   session.expires_at,
        host_name:    host?.name || "",
        is_creator:   isCreator,
        can_edit:     isCreator && !isGhoshtiDay,
        blocks:       renderData.blocks
      }), { headers: CORS });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: CORS
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: CORS
    });
  }
}