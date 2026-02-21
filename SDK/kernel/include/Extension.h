#pragma once

#include "Gateway.h"


namespace kernel::extensions
{
  /// <summary>
  /// Base interface which must be implemented by each COMOS kernel extension.
  /// </summary>
  class Extension
  {
  public:
    virtual void Init(Gateway& extensionGateway) = 0;
    virtual void ShutDown(Gateway& extensionGateway) = 0;
    virtual ~Extension() = default;
  };
}