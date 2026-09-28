---
description: Connect Pi Coding Agent and Oh-My-Pi (OMP) using aio-proxy agent configure.
---

# Pi & Oh-My-Pi (OMP) Integration

AIO Proxy injects bridge modules into the extension directories of Pi and OMP.

## Pi Coding Agent

```sh
aio-proxy agent configure pi
```

In Pi prompt:

```text
/login aio-proxy
```

---

## Oh-My-Pi (OMP)

```sh
aio-proxy agent configure omp
```

In OMP prompt:

```text
/login aio-proxy
```

---

## Removal

```sh
aio-proxy agent remove pi
aio-proxy agent remove omp
```
