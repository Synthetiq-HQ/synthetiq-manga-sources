# Sushi Scan

Metadata-only safety integration scaffold.

This module does not fetch, extract, or expose publication content.

Its purpose is to define the safety boundary that a future source
integration must respect:

1. obtain metadata;
2. evaluate the source-provided categories;
3. reject restricted categories;
4. expose only allowed metadata;
5. never proceed to chapter or image extraction for rejected entries.

No credentials, cookies, private metadata, publication content, or
access-control bypass mechanisms are permitted.
