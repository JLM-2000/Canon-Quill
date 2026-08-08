## ADDED Requirements

### Requirement: <Name>
The system SHALL <behavior>.

#### Scenario: <Name>
- GIVEN <context>
- WHEN <event>
- THEN <outcome>

#### Scenario: Missing evidence
- GIVEN an artifact or claim lacks required provenance
- WHEN the phase attempts to advance
- THEN the workflow records the missing evidence and does not claim success

#### Scenario: Conflicting references
- GIVEN selected sources disagree
- WHEN extraction or preparation encounters the conflict
- THEN source precedence and an author decision are recorded before canon changes

#### Scenario: Unanswered author decision
- GIVEN a blocking question has no answer
- WHEN a downstream phase requests its output
- THEN the workflow remains at the question gate

#### Scenario: Stale handoff
- GIVEN a chapter handoff was built from older canon or an older approved chapter
- WHEN the next chapter begins
- THEN the handoff is rejected or rebuilt before drafting

#### Scenario: Failed validation
- GIVEN a required gate or subaudit fails
- WHEN the validator emits its transition
- THEN the workflow routes to the correct repair phase and preserves the failed report

#### Scenario: Drive overwrite refusal
- GIVEN a target file already exists and overwrite is not explicitly enabled
- WHEN posting is attempted
- THEN the safe Drive tool refuses the write and all local artifacts remain intact

#### Scenario: Provider failure or cancellation
- GIVEN a model provider fails or the author cancels
- WHEN the active phase stops
- THEN the run state and exact reason are persisted without losing approved work

## MODIFIED Requirements

## Artifact Contracts

## Permission Contracts

## State And Transition Contracts

## REMOVED Requirements
