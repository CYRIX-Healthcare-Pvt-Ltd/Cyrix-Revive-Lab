import { describe, it, expect } from 'vitest'
import { amountFromText } from './billOcr'

describe('the amount on a bill, from its recognised text', () => {
  it('takes the grand total over the sub total above it', () => {
    expect(amountFromText(`KOCHI ELECTRONICS
GSTIN 32ABCDE1234F1Z5   Ph 9847012345
Date 17/09/2026   Inv No 1432
LM358 IC            2    12.00     24.00
IRFP460 MOSFET      1   185.00    185.00
Sub Total                         209.00
CGST 9%                            18.81
SGST 9%                            18.81
Grand Total                   ₹ 246.62`)).toBe(246.62)
  })

  it('reads Indian grouping', () => {
    expect(amountFromText('Net Amount Payable  Rs. 1,23,456.50')).toBe(123456.5)
  })

  it('finds the amount on the line under a total that has none on its own', () => {
    expect(amountFromText('TOTAL AMOUNT\n1,240.00\nThank you')).toBe(1240)
  })

  it('does not take a date, a phone number or a GSTIN for the amount', () => {
    expect(amountFromText('Date 17/09/2026\nPh 9847012345\nGSTIN 32ABCDE1234F1Z5\nTotal 58')).toBe(58)
  })

  it('falls back to the largest amount written with paise when there is no total line', () => {
    expect(amountFromText('Resistor 10.00\nCapacitor 45.50\nCash 55.50')).toBe(55.5)
  })

  it('says nothing when it finds nothing', () => {
    expect(amountFromText('illegible scribble')).toBeNull()
    expect(amountFromText('')).toBeNull()
  })
})
