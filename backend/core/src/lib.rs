//! DB Viewer Core Library
//!
//! Contains domain models, database adapters, and core business logic
//! for the DB Dump Visualization service.

pub mod adapter;
pub mod diff;
pub mod domain;
pub mod error;
pub mod risk;
pub mod schema;
pub mod sql_gen;

pub use error::{CoreError, Result};
