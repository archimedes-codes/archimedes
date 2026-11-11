//! Persistence: the app's SQLite database (session history + message
//! transcripts) and the rows it stores.

mod db;

pub use db::{
    Artifact, ArtifactMeta, BoardError, Db, DbError, MessageRow, MoveOutcome, SessionRecency,
    SessionRow, SpaceRow, StageRow, StageWithTasks, TaskCardView, TaskRow, TaskSessionRow,
};
