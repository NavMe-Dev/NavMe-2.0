"""Navmesh pathfinding: A* over triangle adjacency + the Simple Stupid Funnel Algorithm.

Shared by the API (server-side routing, wayfinding_api.services.navgraph) so there is one
implementation of "find a taut path across this floor's triangulated walkable area" rather
than two drifting copies. The mesh itself is built once per building by
wfpipe.steps.navmesh and read back here per request — this module does no I/O.

Triangle data shape (one floor of out/navmesh.json): {"verts": [[x,y],...], "tris": [[i,j,k],...]}
"""
import heapq
import math


def _centroid(verts, tri):
    a, b, c = verts[tri[0]], verts[tri[1]], verts[tri[2]]
    return ((a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0)


def _sign(ax, ay, bx, by, cx, cy):
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _point_in_triangle(px, py, verts, tri):
    a, b, c = verts[tri[0]], verts[tri[1]], verts[tri[2]]
    d1 = _sign(px, py, a[0], a[1], b[0], b[1])
    d2 = _sign(px, py, b[0], b[1], c[0], c[1])
    d3 = _sign(px, py, c[0], c[1], a[0], a[1])
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def _nearest_point_on_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return ax + dx * t, ay + dy * t


def _nearest_point_on_triangle(px, py, verts, tri):
    """Nearest point ON the triangle's boundary (used only when the point is NOT contained —
    callers must never use a raw off-mesh coordinate as a path point, or a point the wrong
    side of a wall from its snapped triangle can produce a straight line that cuts through it)."""
    a, b, c = verts[tri[0]], verts[tri[1]], verts[tri[2]]
    best, best_d = None, float("inf")
    for (x1, y1), (x2, y2) in ((a, b), (b, c), (c, a)):
        qx, qy = _nearest_point_on_segment(px, py, x1, y1, x2, y2)
        d = (qx - px) ** 2 + (qy - py) ** 2
        if d < best_d:
            best_d, best = d, (qx, qy)
    return best


def find_triangle(px, py, verts, tris):
    """(triangle_index, exact) — exact=True if the point genuinely falls inside a triangle;
    otherwise the nearest-centroid triangle and exact=False (point just outside the mesh:
    rounding, a POI a little off the walkable polygon, or genuinely outside mesh coverage
    entirely). Callers must treat a non-exact match as a weak snap, not a real position."""
    for i, tri in enumerate(tris):
        if _point_in_triangle(px, py, verts, tri):
            return i, True
    if not tris:
        return None, False
    best_i, best_d = None, float("inf")
    for i, tri in enumerate(tris):
        cx, cy = _centroid(verts, tri)
        d = (cx - px) ** 2 + (cy - py) ** 2
        if d < best_d:
            best_d, best_i = d, i
    return best_i, False


def build_adjacency(tris):
    """neighbours[i] = [adj-or-None for edge (0,1), edge (1,2), edge (2,0)]."""
    edge_owner = {}
    for i, tri in enumerate(tris):
        for e in range(3):
            a, b = tri[e], tri[(e + 1) % 3]
            edge_owner.setdefault((min(a, b), max(a, b)), []).append(i)
    neighbours = [[None, None, None] for _ in tris]
    for i, tri in enumerate(tris):
        for e in range(3):
            a, b = tri[e], tri[(e + 1) % 3]
            owners = edge_owner.get((min(a, b), max(a, b)), [])
            other = [o for o in owners if o != i]
            if other:
                neighbours[i][e] = other[0]
    return neighbours


def _astar_triangles(tris, verts, neighbours, start_tri, goal_tri):
    if start_tri == goal_tri:
        return [start_tri]
    goal_c = _centroid(verts, tris[goal_tri])

    def h(i):
        c = _centroid(verts, tris[i])
        return math.hypot(c[0] - goal_c[0], c[1] - goal_c[1])

    open_heap = [(h(start_tri), 0.0, start_tri)]
    came_from = {}
    g_score = {start_tri: 0.0}
    visited = set()
    while open_heap:
        _, g, cur = heapq.heappop(open_heap)
        if cur in visited:
            continue
        visited.add(cur)
        if cur == goal_tri:
            path = [cur]
            while cur in came_from:
                cur = came_from[cur]
                path.append(cur)
            path.reverse()
            return path
        cc = _centroid(verts, tris[cur])
        for nb in neighbours[cur]:
            if nb is None or nb in visited:
                continue
            nc = _centroid(verts, tris[nb])
            step = math.hypot(nc[0] - cc[0], nc[1] - cc[1])
            ng = g + step
            if ng < g_score.get(nb, float("inf")):
                g_score[nb] = ng
                came_from[nb] = cur
                heapq.heappush(open_heap, (ng + h(nb), ng, nb))
    return None


def _shared_edge(tri_a, tri_b):
    """The two vertex ids tri_a and tri_b have in common (the portal between them)."""
    shared = [v for v in tri_a if v in tri_b]
    return shared if len(shared) == 2 else None


def _triarea2(ax, ay, bx, by, cx, cy):
    return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)


def _funnel(start, goal, portals):
    """Simple Stupid Funnel Algorithm. `portals` is a list of (left_xy, right_xy) pairs from
    the start triangle's shared edges through to the goal point, already appended by the caller
    as a degenerate (goal, goal) portal. Returns the taut path as a list of (x, y)."""
    path = [start]
    apex = start
    left = portals[0][0]
    right = portals[0][1]
    apex_i = left_i = right_i = 0

    i = 1
    while i < len(portals):
        pl, pr = portals[i]

        # Right side narrowing / crossing.
        if _triarea2(apex[0], apex[1], right[0], right[1], pr[0], pr[1]) <= 0:
            if apex == right or _triarea2(apex[0], apex[1], left[0], left[1], pr[0], pr[1]) > 0:
                right = pr
                right_i = i
            else:
                path.append(left)
                apex = left
                apex_i = left_i
                left = apex
                right = apex
                left_i = right_i = apex_i
                i = apex_i
                i += 1
                continue

        # Left side narrowing / crossing.
        if _triarea2(apex[0], apex[1], left[0], left[1], pl[0], pl[1]) >= 0:
            if apex == left or _triarea2(apex[0], apex[1], right[0], right[1], pl[0], pl[1]) < 0:
                left = pl
                left_i = i
            else:
                path.append(right)
                apex = right
                apex_i = right_i
                left = apex
                right = apex
                left_i = right_i = apex_i
                i = apex_i
                i += 1
                continue

        i += 1

    path.append(goal)
    # Drop any accidental exact-duplicate consecutive points.
    out = [path[0]]
    for p in path[1:]:
        if p != out[-1]:
            out.append(p)
    return out


def route_on_mesh(floor_mesh, start_xy, goal_xy):
    """floor_mesh: {"verts": [[x,y],...], "tris": [[i,j,k],...]} for one floor.
    Returns a list of (x, y) model-space points from start_xy to goal_xy following the
    walkable surface, or None if the mesh is empty / no path exists."""
    verts = floor_mesh.get("verts") or []
    tris = floor_mesh.get("tris") or []
    if not verts or not tris:
        return None
    orig_start, orig_goal = start_xy, goal_xy
    start_tri, start_exact = find_triangle(start_xy[0], start_xy[1], verts, tris)
    goal_tri, goal_exact = find_triangle(goal_xy[0], goal_xy[1], verts, tris)
    if start_tri is None or goal_tri is None:
        return None
    # A non-exact match means the point is genuinely outside every triangle (just past the
    # mesh edge, or nowhere near real coverage on a fragmented floor). Never use the raw
    # input coordinate for such a point in any downstream geometry: it can sit on the wrong
    # side of a wall from the triangle it snapped to, and a straight line from there would
    # cut through that wall. Clamp it onto the snapped triangle's own boundary instead — and
    # if even that clamp is implausibly far away, the "nearest" triangle is an unrelated
    # fragment, not a real snap, so give up and let the caller fall back to sweep-graph routing.
    max_snap_dist = 3.0
    if not start_exact:
        start_xy = _nearest_point_on_triangle(orig_start[0], orig_start[1], verts, tris[start_tri])
        if math.hypot(start_xy[0] - orig_start[0], start_xy[1] - orig_start[1]) > max_snap_dist:
            return None
    if not goal_exact:
        goal_xy = _nearest_point_on_triangle(orig_goal[0], orig_goal[1], verts, tris[goal_tri])
        if math.hypot(goal_xy[0] - orig_goal[0], goal_xy[1] - orig_goal[1]) > max_snap_dist:
            return None
    if start_tri == goal_tri:
        return [tuple(start_xy), tuple(goal_xy)]
    neighbours = build_adjacency(tris)
    tri_path = _astar_triangles(tris, verts, neighbours, start_tri, goal_tri)
    if not tri_path:
        return None

    portals = [(start_xy, start_xy)]
    for a, b in zip(tri_path, tri_path[1:]):
        edge = _shared_edge(tris[a], tris[b])
        if not edge:
            return None  # adjacency inconsistency — let the caller use the safe sweep-graph path
        l, r = verts[edge[0]], verts[edge[1]]
        # Orient the portal so "left"/"right" are consistent with the direction of travel —
        # the funnel algorithm requires this or it narrows on the wrong side.
        cx, cy = _centroid(verts, tris[a])
        if _triarea2(cx, cy, l[0], l[1], r[0], r[1]) < 0:
            l, r = r, l
        portals.append((l, r))
    portals.append((goal_xy, goal_xy))

    pts = _funnel(tuple(start_xy), tuple(goal_xy), portals)
    return pts
