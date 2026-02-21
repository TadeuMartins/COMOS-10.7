#pragma once
#include "exception/runtime_error.h"


namespace kernel::dependency
{
  class IDependency
  {
  public:
    virtual ~IDependency() = default;

    template <typename Implementation>
    Implementation& As();
  };


  template <typename Implementation>
  Implementation& IDependency::As()
  {
    auto result = dynamic_cast<Implementation*>(this);
    if (result == nullptr)
      throw exception::runtime_error(L"requested implementation not available");

    return *result;
  }
}
