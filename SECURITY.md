# Security

Please do not publish suspected vulnerabilities in a public issue. Report them privately through GitHub's **Security > Report a vulnerability** flow for this repository.

Include the affected version, a minimal reproduction, the expected security impact, and any conditions required to trigger it. Do not include real credentials, private files, or data belonging to other people.

Parcelweave validates its wire format, offsets, identifiers, and configured request limits. Applications remain responsible for authentication, authorization, quotas, CSRF protection when cookies are used, safe destination selection, malware or media inspection, and cleanup of abandoned uploads. An upload ID is not proof that a caller owns an upload.
