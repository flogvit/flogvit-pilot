# Contributing to flogvit-pilot

Thanks for your interest in contributing! This project is open source under the MIT license and we welcome contributions.

## How to Contribute

1. **Fork** the repository
2. **Create a branch** from `main` for your changes (`git checkout -b feature/my-feature`)
3. **Make your changes** and commit with clear, descriptive messages
4. **Push** your branch to your fork
5. **Open a Pull Request** against `main`

## Development Setup

```bash
# Install dependencies
bun install

# Run the CLI
bun run src/cli.ts

# Run tests
bun test
```

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what the change does and why
- Make sure tests pass (`bun test`)
- Follow the existing code style

## Branch Policy

- Only maintainers can merge to `main`
- All changes go through pull requests

## Reporting Issues

Use [GitHub Issues](https://github.com/flogvit/flogvit-pilot/issues) to report bugs or suggest features. Please include:

- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
