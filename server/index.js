// Trip To-Dos — a dashboard sidebar widget.
//
// One route: GET /tasks → every OPEN to-do across every trip the acting user can
// see, each tagged with its trip and sorted by due date (overdue first, undated
// last). The host binds the acting user from the request and membership-checks each
// trip, so a plugin only ever reads to-dos the user themselves could open.
//
// Needs: db:read:trips (trips.listMine) + db:read:todos (todos.list).

// Cap how many trips we fan out over in one request. `trips.listMine` + one
// `todos.list` per trip are separate host RPCs, and the host rate-limits a plugin's
// calls (burst ~60). Staying under that keeps a user with a huge trip history from
// tripping the limiter — the newest trips are what a "what's due" widget is about.
const MAX_TRIPS = 50;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/tasks',
      auth: true,
      async handler(_req, ctx) {
        const json = { 'content-type': 'application/json' };

        let trips = [];
        try {
          const mine = await ctx.trips.listMine();
          if (Array.isArray(mine)) trips = mine;
        } catch (e) {
          // No trip read (revoked grant / userless) — surface an empty, valid payload.
          return { status: 200, headers: json, body: JSON.stringify({ tasks: [], tripCount: 0, totalOpen: 0, truncated: false }) };
        }

        const tripCount = trips.length;
        const scanned = trips.slice(0, MAX_TRIPS);
        const tasks = [];

        for (const t of scanned) {
          if (!t || t.id == null) continue;
          let items = [];
          try {
            const list = await ctx.todos.list(t.id);
            if (Array.isArray(list)) items = list;
          } catch (e) {
            continue; // one trip's read failing must not drop the whole widget
          }
          for (const it of items) {
            if (!it || it.checked) continue; // open == not checked off
            tasks.push({
              id: it.id,
              name: String(it.name == null ? '' : it.name).slice(0, 200),
              dueDate: it.due_date || null,
              priority: num(it.priority),
              category: it.category ? String(it.category).slice(0, 60) : null,
              tripId: t.id,
              tripTitle: String(t.title == null ? '' : t.title).slice(0, 80) || 'Trip',
            });
          }
        }

        const totalOpen = tasks.length;

        // Dated tasks first, earliest due first (overdue floats to the top); within a
        // day, higher priority first. Undated tasks sink below all dated ones, ordered
        // by priority.
        tasks.sort((a, b) => {
          if (a.dueDate && b.dueDate) {
            if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
            return b.priority - a.priority;
          }
          if (a.dueDate) return -1;
          if (b.dueDate) return 1;
          return b.priority - a.priority;
        });

        return {
          status: 200,
          headers: json,
          body: JSON.stringify({
            tasks,
            tripCount,
            totalOpen,
            truncated: tripCount > scanned.length,
          }),
        };
      },
    },
  ],
};
