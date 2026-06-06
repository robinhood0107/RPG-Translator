use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    InvalidInput { message: String },
    Sqlite(rusqlite::Error),
    UnsupportedPhaseOperation { phase: String },
}

impl Error {
    #[must_use]
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput {
            message: message.into(),
        }
    }

    #[must_use]
    pub fn unsupported_phase_operation(phase: impl Into<String>) -> Self {
        Self::UnsupportedPhaseOperation {
            phase: phase.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput { message } => write!(f, "invalid input: {message}"),
            Self::Sqlite(error) => write!(f, "sqlite error: {error}"),
            Self::UnsupportedPhaseOperation { phase } => {
                write!(f, "unsupported operation in phase: {phase}")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::InvalidInput { .. } | Self::UnsupportedPhaseOperation { .. } => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}
