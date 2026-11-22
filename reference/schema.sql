PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, small_cell INTEGER NOT NULL CHECK (small_cell >= 1)
);
CREATE TABLE IF NOT EXISTS department (
    workspace TEXT NOT NULL REFERENCES workspace, id TEXT NOT NULL, name TEXT NOT NULL,
    PRIMARY KEY (workspace, id)
);
CREATE TABLE IF NOT EXISTS member (
    workspace TEXT NOT NULL REFERENCES workspace, actor TEXT NOT NULL, role TEXT NOT NULL,
    department TEXT, PRIMARY KEY (workspace, actor),
    FOREIGN KEY (workspace, department) REFERENCES department
);
CREATE TABLE IF NOT EXISTS project (
    workspace TEXT NOT NULL, id TEXT NOT NULL, department TEXT NOT NULL,
    title TEXT NOT NULL, design TEXT NOT NULL, stage TEXT NOT NULL, version INTEGER NOT NULL,
    owner TEXT NOT NULL, PRIMARY KEY (workspace, id),
    FOREIGN KEY (workspace, department) REFERENCES department,
    FOREIGN KEY (workspace, owner) REFERENCES member
);
CREATE TABLE IF NOT EXISTS clearance (
    workspace TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL,
    decision TEXT NOT NULL, reference TEXT NOT NULL, expires TEXT, actor TEXT NOT NULL,
    PRIMARY KEY (workspace, project, kind),
    FOREIGN KEY (workspace, project) REFERENCES project,
    FOREIGN KEY (workspace, actor) REFERENCES member
);
CREATE TABLE IF NOT EXISTS metric_definition (
    workspace TEXT NOT NULL REFERENCES workspace, id TEXT NOT NULL, label TEXT NOT NULL,
    target_bp INTEGER NOT NULL CHECK (target_bp BETWEEN 0 AND 10000),
    PRIMARY KEY (workspace, id)
);
CREATE TABLE IF NOT EXISTS metric (
    workspace TEXT NOT NULL, department TEXT NOT NULL, period TEXT NOT NULL,
    metric TEXT NOT NULL, numerator INTEGER NOT NULL, denominator INTEGER NOT NULL,
    submitted_by TEXT NOT NULL, verified_by TEXT,
    PRIMARY KEY (workspace, department, period, metric),
    CHECK (numerator >= 0 AND denominator >= numerator),
    FOREIGN KEY (workspace, department) REFERENCES department,
    FOREIGN KEY (workspace, metric) REFERENCES metric_definition,
    FOREIGN KEY (workspace, submitted_by) REFERENCES member,
    FOREIGN KEY (workspace, verified_by) REFERENCES member
);
CREATE TABLE IF NOT EXISTS report (
    workspace TEXT NOT NULL REFERENCES workspace, id TEXT NOT NULL, period TEXT NOT NULL,
    revision INTEGER NOT NULL, snapshot TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL, author TEXT NOT NULL, approved_by TEXT, released_by TEXT,
    PRIMARY KEY (workspace, id), UNIQUE (workspace, period, revision),
    FOREIGN KEY (workspace, author) REFERENCES member,
    FOREIGN KEY (workspace, approved_by) REFERENCES member,
    FOREIGN KEY (workspace, released_by) REFERENCES member
);
CREATE UNIQUE INDEX IF NOT EXISTS current_report ON report (workspace, period)
WHERE status = 'published';
CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY, workspace TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    entity TEXT NOT NULL, detail TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace, actor) REFERENCES member
);
