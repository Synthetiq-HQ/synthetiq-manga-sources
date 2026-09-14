# Audio Catalogue Rollout - Staged Only

LibriVox 1.0.1 is copied unchanged from Synthetiq-HQ/audio-testing. Its stable ID,
manifest, script, icon and hashes are preserved. Existing main entries are unchanged.

Do not merge this branch into the legacy live index yet. Older Books versions
decode the entire index with a content-type enum that has no audio case. A new
audio entry can fail the whole refresh before minimumAppVersion is evaluated.
Updating the new app alone does not protect people still using those versions.

Use a version-aware catalogue rollout or a separate index selected by compatible
app versions before publishing to main. Keep Audio Testing online throughout the
transition. Do not delete it until existing subscriptions have a tested migration.

Availability in a catalogue is not automatic installation. Users must have the
repository added and explicitly install the module. This is an audiobook module,
not a podcast RSS catalogue. No additional podcasts are introduced here.
