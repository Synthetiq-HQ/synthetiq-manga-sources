# Audio Catalogue Rollout - Owner-Approved Main Publication

LibriVox 1.0.1 is copied unchanged from Synthetiq-HQ/audio-testing. Its stable ID,
manifest, script, icon and hashes are preserved. Existing main entries are unchanged.

On 2026-09-15 the owner explicitly approved publishing to main after the new
Books release, accepting the compatibility risk for older clients. Older Books versions
decode the entire index with a content-type enum that has no audio case. A new
audio entry can fail the whole refresh before minimumAppVersion is evaluated.
Updating the new app alone does not protect people still using those versions.

Affected users must update Books before refreshing this catalogue. A version-aware
catalogue remains the preferred future compatibility fix. Keep Audio Testing online throughout the
transition. Do not delete it until existing subscriptions have a tested migration.

Availability in a catalogue is not automatic installation. Users must have the
repository added and explicitly install the module. This is an audiobook module,
not a podcast RSS catalogue. No additional podcasts are introduced here.
