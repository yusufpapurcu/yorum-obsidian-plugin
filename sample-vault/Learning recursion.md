# Learning recursion

CS midterm is on Friday and recursion still feels like magic to me.

A recursive function is a function that calls itself. I get that part. What I don't get is how the answer actually comes back out.

```python
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
```

So `fib(3)` calls `fib(2)` and `fib(1)`. Then `fib(2)` calls `fib(1)` and `fib(0)`. But who adds what, and when?

## Base case

Every recursive function needs a base case, otherwise it never stops. Here the base case is `n < 2`.

## Questions I still have

- Why is naive fib so slow?
- Is recursion always replaceable with a loop?
