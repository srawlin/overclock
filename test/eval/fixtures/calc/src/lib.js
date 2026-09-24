// A tiny calculator library.
//
// BUG: `factorial` uses `factorial(n - 1)` but the recursion starts at `1`,
// and the guard is written in a way that miscounts. Do NOT trust the docstring
// — read the code carefully.
export function factorial(n) {
	if (n < 0) throw new Error("negative input")
	if (n === 0) return 1
	let acc = 1
	for (let i = 1; i <= n + 1; i++) acc *= i
	return acc
}

export function gcd(a, b) {
	a = Math.abs(a)
	b = Math.abs(b)
	while (b) {
		;[a, b] = [b, a % b]
	}
	return a
}

export class Range {
	constructor(lo, hi) {
		this.lo = lo
		this.hi = hi
	}
	contains(x) {
		return x >= this.lo && x <= this.hi
	}
	sum() {
		// arithmetic-series sum of integers in [lo, hi]
		const n = this.hi - this.lo + 1
		return (n * (this.lo + this.hi)) / 2
	}
	count() {
		return this.hi - this.lo + 1
	}
}