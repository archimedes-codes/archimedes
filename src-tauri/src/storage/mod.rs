//! Persistence: the app's SQLite database (session history + message
//! transcripts) and the rows it stores.

mod batching;
mod db;

pub use batching::{BatchingPersistence, DEFAULT_FLUSH_INTERVAL};

pub use db::{
    Artifact, ArtifactMeta, BoardError, Db, DbError, FieldPatch, MessageRow, MoveOutcome,
    SessionRecency, SessionRow, SpaceRow, StageRow, StageWithTasks, TaskCardView, TaskNumberRow,
    TaskRow, TaskSessionRow,
};
