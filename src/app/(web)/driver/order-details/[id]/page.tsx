'use client'

import { useState, useRef } from "react"
import { useParams } from "next/navigation"
import { useSession } from "next-auth/react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Copy, MapPin, Phone, Printer, Package, CheckCircle, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { toast } from "sonner"
import Image from "next/image"
import jsPDF from "jspdf"
import html2canvas from "html2canvas"
import { JobDetailsSkeleton } from "./_components/skeleton"

/* ================= TYPES ================= */

type OrderStatus = "PENDING" | "ON_MY_WAY" | "PICKED_UP" | "COMPLETED"

interface PackageItem {
  packageNumber: string
  barcodeImages: string[]
}

interface Store {
  store: string
  packages: PackageItem[]
}

interface Customer {
  firstName: string
  lastName: string
  phone: string
  address?: { street: string; city: string; zipCode: string }
  pickupLocation?: { address: string }
}

interface ReturnOrderData {
  _id: string
  customer: Customer
  stores: Store[]
  status: OrderStatus
  paymentStatus: string
  options?: {
    physicalReturnLabel?: {
      enabled: boolean
      labelFiles: string[]
    }
  }
}

/* ================= API ================= */

const fetchReturnOrder = async (orderId: string, token: string): Promise<ReturnOrderData> => {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/return-order/see-details/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const result = await res.json()
  if (!res.ok || !result.status) throw new Error(result.message || "Failed to fetch order")
  return result.data
}

const updateOrderStatus = async ({ orderId, token, status }: { orderId: string; token: string; status: OrderStatus }) => {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/return-order/${orderId}/driver-status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status }),
  })
  const result = await res.json()
  if (!res.ok || !result.status) throw new Error(result.message || "Status update failed")
  return result.data
}

export default function JobDetailsPage() {
  const { id: orderId } = useParams<{ id: string }>()
  const { data: session, status: sessionStatus } = useSession()
  const token = session?.accessToken as string
  const queryClient = useQueryClient()

  const pdfTemplateRef = useRef<HTMLDivElement>(null)
  const [activePkg, setActivePkg] = useState<{ id: string; store: string; barcodeImage: string } | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)

  /* ---------- QUERY ---------- */
  const { data: orderData, isLoading, isError } = useQuery<ReturnOrderData>({
    queryKey: ["returnOrder", orderId],
    queryFn: () => fetchReturnOrder(orderId!, token),
    enabled: !!orderId && !!token && sessionStatus === "authenticated",
  })

  /* ---------- MUTATION ---------- */
  const updateStatusMutation = useMutation({
    mutationFn: updateOrderStatus,
    onSuccess: (updated) => {
      queryClient.setQueryData<ReturnOrderData>(["returnOrder", orderId], (old) =>
        old ? { ...old, status: updated.status } : old
      )
      toast.success("Status updated")
    },
    onError: (err: Error) => toast.error(err.message),
  })

  /* ================= DATA ================= */
  const allPackages = orderData?.stores.flatMap((store) =>
    store.packages.map((pkg) => ({
      id: pkg.packageNumber,
      store: store.store,
      barcodeImage: pkg.barcodeImages?.[0] || "",
    }))
  ) || []

  const returnLabelImage = orderData?.options?.physicalReturnLabel?.enabled
    ? orderData.options.physicalReturnLabel.labelFiles?.[0]
    : null

  const customer = orderData?.customer
  const fullName = `${customer?.firstName || ""} ${customer?.lastName || ""}`
  const address = customer?.pickupLocation?.address || (customer?.address ? `${customer.address.street}, ${customer.address.city}, ${customer.address.zipCode}` : "N/A")
  const orderStatus = orderData?.status ?? "PENDING"

  /* ================= PDF PRINT LOGIC ================= */
  const handlePrintAsPDF = async (pkg: { id: string; store: string; barcodeImage: string } | 'return-label') => {
    setIsGenerating(true)
    const toastId = toast.loading("Generating label...")

    let targetPkg: { id: string; store: string; barcodeImage: string }

    if (pkg === 'return-label') {
      if (!returnLabelImage) {
        toast.error("Return label not available", { id: toastId })
        setIsGenerating(false)
        return
      }
      targetPkg = { id: 'Return Label', store: 'Return Shipping Label', barcodeImage: returnLabelImage }
    } else {
      targetPkg = pkg
      if (!targetPkg.barcodeImage) {
        toast.error("No barcode image available", { id: toastId })
        setIsGenerating(false)
        return
      }
    }

    setActivePkg(targetPkg)

    setTimeout(async () => {
      try {
        const element = pdfTemplateRef.current
        if (!element) {
          toast.error("Template error", { id: toastId })
          setIsGenerating(false)
          return
        }

        const canvas = await html2canvas(element, {
          scale: 4,
          useCORS: true,
          backgroundColor: "#ffffff",
          logging: false,
        })

        const imgData = canvas.toDataURL("image/png", 1.0)
        const pdf = new jsPDF({
          orientation: "portrait",
          unit: "mm",
          format: "a4"
        })

        const pdfWidth = pdf.internal.pageSize.getWidth()
        const pdfHeight = pdf.internal.pageSize.getHeight()

        const imgWidth = canvas.width / 4
        const imgHeight = canvas.height / 4
        const ratio = Math.min(pdfWidth / imgWidth, pdfHeight / imgHeight)
        const finalWidth = imgWidth * ratio
        const finalHeight = imgHeight * ratio

        pdf.addImage(imgData, "PNG", (pdfWidth - finalWidth) / 2, (pdfHeight - finalHeight) / 2, finalWidth, finalHeight)

        const blob = pdf.output("blob")
        const url = URL.createObjectURL(blob)

        const printWindow = window.open(url, "_blank")

        if (printWindow) {
          printWindow.onload = () => {
            setTimeout(() => {
              printWindow.focus()
              printWindow.print()
            }, 500)
          }
          setTimeout(() => {
            if (!printWindow.closed && printWindow.print) {
              printWindow.focus()
              printWindow.print()
            }
          }, 1500)
          toast.success("Print dialog opened!", { id: toastId })
        } else {
          pdf.save(`Label_${targetPkg.id}.pdf`)
          toast.success("PDF downloaded", { id: toastId })
        }

      } catch (err) {
        console.error(err)
        toast.error("Failed to generate", { id: toastId })
      } finally {
        setIsGenerating(false)
        setActivePkg(null)
      }
    }, 1500)
  }

  const handleStatusUpdate = () => {
    const config = getButtonConfig()
    if (!config?.next) return
    updateStatusMutation.mutate({ orderId: orderId!, token, status: config.next as OrderStatus })
  }

  const getButtonConfig = () => {
    switch (orderStatus) {
      case "PENDING": return { text: "Start Job (On my way)", next: "ON_MY_WAY" }
      case "ON_MY_WAY": return { text: "Confirm Pickup", next: "PICKED_UP" }
      case "PICKED_UP": return { text: "Complete Job", next: "COMPLETED" }
      case "COMPLETED": return { text: "COMPLETED", next: null, icon: <CheckCircle className="h-5 w-5 mr-2" /> }
      default: return null
    }
  }
  const buttonConfig = getButtonConfig()

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(`${label} copied!`)
  }

  if (sessionStatus === "loading" || isLoading) return <JobDetailsSkeleton />
  if (isError || !orderData) return <div className="p-10 text-center text-red-500">Error loading job details.</div>

  return (
    <>
      {/* HIDDEN PDF TEMPLATE - MINIMAL: ONLY TITLE, STORE & BARCODE */}
      <div style={{ position: 'absolute', left: '-9999px', top: '-9999px', pointerEvents: 'none' }}>
        <div ref={pdfTemplateRef} className="bg-white" style={{ width: '1000px', padding: '120px 80px' }}>
          <div className="border-2 border-black flex flex-col items-center justify-start min-h-[1200px]">
            {/* Header */}
            <div className="text-center mb-16">
              <h1 className="text-6xl font-bold uppercase tracking-widest">PACKAGE LABEL</h1>
              <p className="text-3xl text-gray-700 mt-8">Store: {activePkg?.store || "OTHER"}</p>
            </div>

            {/* Large Centered Barcode - Takes most of the space */}
            <div className="flex-1 flex items-center justify-center w-full">
              {activePkg?.barcodeImage && (
                <Image
                  src={activePkg.barcodeImage}
                  crossOrigin="anonymous"
                  alt="Barcode"
                  width={1600}
                  height={900}
                  className="max-w-full max-h-full object-contain"
                  unoptimized
                  priority
                />
              )}
            </div>

            {/* NO PACKAGE NUMBER - REMOVED */}
            {/* NO FOOTER - REMOVED */}
          </div>
        </div>
      </div>

      {/* MAIN SCREEN VIEW - 100% UNCHANGED */}
      <div className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-5xl">
          {/* HEADER */}
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 md:text-3xl">Job Details</h1>
              <p className="text-sm text-gray-500 mt-1 font-medium">Order # {orderData._id.slice(-8)}</p>
            </div>
            <span className="rounded-full bg-green-100 px-4 py-1.5 text-xs sm:text-sm font-semibold text-green-700 ring-1 ring-inset ring-green-600/20">{orderData.status}</span>
          </div>

          {/* CUSTOMER */}
          <Card className="mb-8 overflow-hidden border-none shadow-sm ring-1 ring-gray-200">
            <div className="p-5 sm:p-6">
              <h2 className="mb-4 text-[11px] font-bold uppercase tracking-widest text-gray-400">Customer Details</h2>
              <h3 className="mb-5 text-xl font-bold text-gray-900">{fullName}</h3>
              <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:justify-start lg:gap-8">
                  <div className="flex items-start gap-3">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                    <span className="text-sm leading-relaxed text-gray-600">{address}</span>
                  </div>
                  <button onClick={() => handleCopy(address, "Address")} className="flex w-fit items-center gap-1.5 rounded-md border border-sky-400 bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-tight text-sky-500 hover:bg-sky-50 transition-colors"><Copy className="h-3 w-3" /> (copy)</button>
                </div>
                {customer?.phone && (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:justify-start lg:gap-8">
                    <div className="flex items-center gap-3">
                      <Phone className="h-4 w-4 shrink-0 text-gray-400" />
                      <span className="text-sm font-medium text-gray-600">{customer.phone}</span>
                    </div>
                    <button onClick={() => handleCopy(customer.phone, "Phone number")} className="flex w-fit items-center gap-1.5 rounded-md border border-sky-400 bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-tight text-sky-500 hover:bg-sky-50 transition-colors">
                      <Copy className="h-3 w-3" /> (copy)
                    </button>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* RETURN LABEL */}
          {returnLabelImage && (
            <div className="mb-8">
              <div className="flex justify-between items-center mb-4 px-1">
                <h2 className="text-sm font-bold uppercase text-gray-500 tracking-tight flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Return Shipping Label
                </h2>
                <Button onClick={() => handlePrintAsPDF('return-label')} variant="outline" size="sm" className="h-9 gap-2 border-gray-200 bg-white text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50">
                   <Printer className="h-4 w-4" /> Print PDF
                </Button>
              </div>
              <Card className="p-6 bg-gray-50">
                 <div className="relative h-48 w-full flex justify-center">
                    <Image src={returnLabelImage} alt="Return Label" width={10000} height={10000} className="h-full object-contain rounded-lg shadow-sm bg-white" />
                 </div>
              </Card>
            </div>
          )}

          {/* PACKAGES */}
          <div className="mb-4 flex items-center justify-between px-1">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-tight">Packages ({allPackages.length})</h2>
            {allPackages.length > 0 && allPackages[0].barcodeImage && (
              <Button onClick={() => handlePrintAsPDF(allPackages[0])} variant="outline" size="sm" className="h-9 gap-2 border-gray-200 bg-white text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50">
                <Printer className="h-4 w-4" />
                <span className="hidden xs:inline">Print PDF</span>
              </Button>
            )}
          </div>

          <div className="space-y-4">
            {allPackages.map(pkg => (
              <Card key={pkg.id} className="border-none shadow-sm ring-1 ring-gray-200 transition-shadow hover:shadow-md">
                <div className="flex flex-col p-4 sm:flex-row sm:items-center sm:justify-between gap-5">
                  <div className="flex items-center gap-4">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-gray-100 border border-gray-200">
                      <Package className="h-7 w-7 text-gray-400" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-gray-900">{pkg.store}</h3>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <div className="h-2 w-2 rounded-full bg-gray-300"></div>
                        <span className="font-mono text-[10px] font-bold text-gray-400 uppercase tracking-widest">{pkg.id}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-6 border-t border-gray-50 pt-4 sm:border-none sm:pt-0">
                    <button 
                      onClick={() => handlePrintAsPDF(pkg)} 
                      disabled={isGenerating || !pkg.barcodeImage}
                      className="group flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-white p-3 transition-all hover:border-sky-400 hover:shadow-sm active:scale-95 disabled:opacity-50"
                    >
                      {pkg.barcodeImage ? (
                        <Image 
                          src={pkg.barcodeImage} 
                          crossOrigin="anonymous" 
                          width={100} 
                          height={100} 
                          alt={`Barcode ${pkg.id}`} 
                          className="h-16 w-auto object-contain" 
                          unoptimized 
                        />
                      ) : (
                        <div className="h-16 w-56 bg-gray-200 border-2 border-dashed rounded flex items-center justify-center">
                          <span className="text-xs text-gray-500">No barcode</span>
                        </div>
                      )}
                      <span className="text-[9px] font-black uppercase tracking-tighter text-gray-400 group-hover:text-sky-500">
                        {isGenerating && activePkg?.id === pkg.id ? 'Generating...' : 'Print Label PDF'}
                      </span>
                    </button>
                  </div>
                </div>
              </Card>
            ))}

            {/* STATUS BUTTON */}
            {buttonConfig && (
              <Button onClick={handleStatusUpdate} disabled={orderStatus === "COMPLETED" || updateStatusMutation.isPending} className={`w-full h-12 text-white rounded-[24px] mt-6 ${orderStatus === "COMPLETED" ? "bg-green-600 cursor-default" : "bg-[#31B8FA] hover:bg-[#31B8FA]/90"}`}>
                {updateStatusMutation.isPending ? "Updating..." : (<>{buttonConfig.icon}{buttonConfig.text}</>)}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}