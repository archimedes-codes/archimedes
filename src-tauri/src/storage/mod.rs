//! Persistence: the app's SQLite database (session history + message
//! transcripts) and the rows it stores.

mod batching;
mod db;

pub use batching::{BatchingPersistence, DEFAULT_FLUSH_INTERVAL};

pub use db::{
    AdvanceAdvice, AdvanceVerdict, Artifact, ArtifactMeta, AutoGuards, BoardError, BoardRow,
    CardOfSession, ChainStop, Db, DbError, FieldPatch, HostToolError, MessageRow, MoveAuthor,
    MoveOutcome, MoveToolOutcome, PrunedCounts, SessionRecency, SessionRow, SpaceRow, StageRow,
    StageWithTasks, TaskCardView, TaskDetail, TaskNumberRow, TaskRow, TaskSessionRow,
    WorkflowRunRow, DEFAULT_AUTO_CEILING_USD, DEFAULT_AUTO_MAX_STEPS,
    MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE, VACUUM_FREELIST_THRESHOLD_BYTES,
};

// The `reason` spellings, one hop closer to the one file outside `storage/` that needs
// them by name: `agent/host_tools/exec/session.rs` matches its sentence table on these
// instead of on literals copied from `db/advise.rs`. `pub(crate)`, because this is an
// internal wire vocabulary and not crate API — and EIGHT, not nine: `REASON_ADVANCED`
// needs no hop because no production arm of that table has to name it. See the
// `pub(crate) use` in `db/mod.rs` for the reason a const cannot be named without it.
pub(crate) use db::{
    REASON_ADVANCED_UNNAMED_EDGE, REASON_ALREADY_ADVANCED, REASON_COST_CEILING, REASON_MAX_STEPS,
    REASON_NOT_AUTOMATIC, REASON_NO_NEXT_STAGE, REASON_UNCLAIMED, REASON_UNLINKED,
};
