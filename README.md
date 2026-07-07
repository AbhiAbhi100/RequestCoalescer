# request-coalescer

[![npm version](https://img.shields.io/npm/v/request-coalescer.svg)](https://www.npmjs.com/package/request-coalescer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6.svg)](https://www.typescriptlang.org/)

A production-quality, lightweight, and type-safe TypeScript utility to merge duplicate concurrent asynchronous requests into a single execution by sharing the same Promise.

Designed to prevent **Cache Stampede (Thundering Herd)** problems and reduce unnecessary API and database load.

---

## Table of Contents

- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Advanced Usage](#advanced-usage)
- [API Reference](#api-reference)
- [License](#license)

---

## The Problem
...