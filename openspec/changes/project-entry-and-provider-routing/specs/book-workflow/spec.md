# Project Entry and Provider Routing

## Requirements

### Requirement: Explicit project entry

The Studio SHALL ask whether the book starts from scratch or with existing
material before requesting Drive access or planning files.

#### Scenario: From scratch

- **Given** a new project with no entry decision
- **When** the author selects `from_scratch` and submits a detailed brief
- **Then** the brief SHALL be stored in the project state
- **And** Drive and source-selection phases SHALL be skippable
- **And** project setup SHALL remain available before writing

#### Scenario: Existing material

- **Given** a new project with no entry decision
- **When** the author selects `with_material`
- **Then** the Studio SHALL offer local text-file upload and Google Drive
- **And** source classification and author review SHALL remain required

#### Scenario: Incomplete scratch brief

- **Given** `from_scratch` is selected
- **When** the submitted brief is too short to establish a story premise
- **Then** the server SHALL reject it
- **And** the project SHALL remain at the entry screen

### Requirement: Evidence-backed questions

The intake system SHALL ask only unresolved project decisions after automatic
prefills and SHALL publish one question at a time without an arbitrary count
limit.

#### Scenario: Three unresolved decisions

- **Given** analysis leaves exactly three unanswered decisions
- **When** intake starts
- **Then** all three SHALL be asked in sequence
- **And** no fourth placeholder question SHALL be invented

#### Scenario: More than three unresolved decisions

- **Given** analysis leaves more than three unanswered decisions
- **When** the author answers each blocking question
- **Then** intake SHALL continue until every planned decision is answered

#### Scenario: Relaunch

- **Given** a question has already been answered and persisted
- **When** the Studio is relaunched
- **Then** it SHALL not ask that question again unless the author explicitly
  resets analysis

### Requirement: Independent provider assignments

The Studio SHALL allow analysis and prose tasks to use different providers and
authentication methods.

#### Scenario: OpenAI analysis and Anthropic prose

- **Given** the author selects split routing
- **When** analysis is assigned to OpenAI and drafting to Anthropic
- **Then** resolved analysis models SHALL come from OpenAI
- **And** resolved drafting and editing models SHALL come from Anthropic
- **And** each assignment SHALL report its own credential status

#### Scenario: Credential isolation

- **Given** API keys are stored for either provider
- **When** project state is returned
- **Then** no key value SHALL appear in the response or project JSON

### Requirement: Chapter planning chat

Chapter-by-chapter mode SHALL provide an author chat associated with each
chapter.

#### Scenario: Chapter guidance

- **Given** a chapter plan exists
- **When** the author sends guidance about events, dialogue, emotional turns,
  or omissions
- **Then** the message SHALL be stored under that chapter
- **And** the drafting agent SHALL be instructed to read it before drafting

### Requirement: Writing confirmation gate

The Studio SHALL require explicit author confirmation after preparation and
before the writing phase is active.

#### Scenario: Confirm preparation

- **Given** all blocking questions are answered and preparation is complete
- **When** the author chooses Start writing and confirms the modal
- **Then** writing SHALL become the derived phase
- **And** Setup and Prepare navigation groups SHALL collapse

#### Scenario: Decline confirmation

- **Given** the confirmation modal is open
- **When** the author chooses Not yet
- **Then** writing SHALL remain locked
- **And** navigation SHALL remain unchanged

#### Scenario: Missing preparation

- **Given** a blocking question or existing-draft decision remains
- **When** the author calls the writing confirmation endpoint
- **Then** the request SHALL fail with a clear error
