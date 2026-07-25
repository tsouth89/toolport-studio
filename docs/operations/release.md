# Desktop release process

Toolport Studio publishes Windows desktop prereleases through the manual
`Release` GitHub Actions workflow. The workflow authenticates to Azure with
GitHub OIDC, builds from `main`, signs through Azure Artifact Signing, verifies
the Authenticode publisher, and fails before publication if signing is not
available.

## Windows alpha

1. Start from a clean commit pushed to `main`.
2. Run the `Release` workflow with the next `0.1.0-alpha.N` version and a short
   release summary.
3. Confirm the workflow's signature verification and artifact upload steps pass.
4. Download the published installer and confirm GitHub's asset digest matches
   the SHA-256 in the release notes.

The `release` GitHub environment contains the Azure application, subscription,
and Artifact Signing configuration. Its Entra application must trust this
federated subject:

```text
repo:tsouth89@258147599/toolport-studio@1311541374:environment:release
```

This repository uses GitHub's ID-hardened OIDC subject format. If the Entra
GitHub Actions wizard only offers the name-only format, create an `Other issuer`
credential with issuer `https://token.actions.githubusercontent.com` and
audience `api://AzureADTokenExchange`. No OAuth redirect URI is used by this
workflow.

## Release scope

The release artifact contains the desktop shell, local server, and web client.
The old T3 marketing, mobile, and hosted relay products are intentionally not
part of Toolport Studio releases.

## Future automation

Before enabling automatic tag-driven releases:

- establish macOS signing and notarization
- produce platform-specific artifacts without cross-platform payloads
- publish update manifests from Toolport Studio's repository
- require smoke checks before release publication
