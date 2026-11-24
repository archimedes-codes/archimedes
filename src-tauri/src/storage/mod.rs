//! Persistence: the app's SQLite database (session history + message
//! transcripts) and the rows it stores.

mod batching;
mod db;

pub use batching::{BatchingPersistence, DEFAULT_FLUSH_INTERVAL};

pub use db::{
    AdvanceVerdict, Artifact, ArtifactMeta, AutoGuards, BoardError, ChainStop, Db, DbError,
    FieldPatch, MessageRow, MoveOutcome, PrunedCounts, SessionRecency, SessionRow, SpaceRow,
    StageRow, StageWithTasks, TaskCardView, TaskNumberRow, TaskRow, TaskSessionRow, WorkflowRunRow,
    DEFAULT_AUTO_CEILING_USD, DEFAULT_AUTO_MAX_STEPS, MAX_CLOSED_SUBAGENT_TRANSCRIPT_AGE,
    VACUUM_FREELIST_THRESHOLD_BYTES,
};
